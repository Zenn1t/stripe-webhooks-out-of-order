"""
Same architecture, FastAPI + SQLAlchemy + Postgres. Condensed to the parts
that carry the design; the NestJS version has the full thing.

Layers:
  ingress  -> verify signature, INSERT ... ON CONFLICT DO NOTHING, return 200
  worker   -> claim per object_id, serially
  project  -> lock, refetch from Stripe, mirror, derive entitlement
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import APIRouter, Header, HTTPException, Request
from sqlalchemy import text

router = APIRouter()

WEBHOOK_SECRET = "whsec_..."

# --------------------------------------------------------------------------
# 1. INGRESS
# --------------------------------------------------------------------------
@router.post("/stripe/webhook", status_code=200)
async def ingress(request: Request, stripe_signature: str = Header(None)):
    raw = await request.body()  # raw bytes, not the parsed model

    try:
        event = stripe.Webhook.construct_event(raw, stripe_signature, WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(status_code=400, detail="invalid signature")

    object_id = extract_object_id(event)

    async with db.begin() as conn:
        # Atomic dedup. Not SELECT-then-INSERT: two concurrent redeliveries
        # both pass the SELECT and both insert.
        await conn.execute(
            text("""
                INSERT INTO stripe_events (id, type, object_id, api_version, payload, received_at)
                VALUES (:id, :type, :object_id, :api_version, :payload, now())
                ON CONFLICT (id) DO NOTHING
            """),
            {
                "id": event["id"], "type": event["type"], "object_id": object_id,
                "api_version": event.get("api_version"), "payload": json.dumps(event),
            },
        )
        await conn.execute(
            text("INSERT INTO sync_locks (object_id) VALUES (:oid) ON CONFLICT DO NOTHING"),
            {"oid": object_id},
        )
    return {"received": True}


def extract_object_id(event) -> str:
    obj = event["data"]["object"]
    t = event["type"]
    if t.startswith("customer.subscription."):
        return obj["id"]
    if t.startswith("invoice."):
        return obj.get("subscription") or obj["id"]
    if t == "checkout.session.completed":
        return obj.get("subscription") or obj["id"]
    return obj.get("id", event["id"])


# --------------------------------------------------------------------------
# 2. PROJECTION — ordering stops mattering here
# --------------------------------------------------------------------------
async def project(object_id: str) -> None:
    """Pure function of Stripe's CURRENT state. Takes no payload, on purpose."""
    if not object_id.startswith("sub_"):
        return

    async with db.begin() as conn:
        # Serialise per object. Everything below runs alone.
        await conn.execute(
            text("SELECT object_id FROM sync_locks WHERE object_id = :oid FOR UPDATE"),
            {"oid": object_id})

        # Fetch INSIDE the lock. Fetching outside lets two workers interleave
        # (fetch A, fetch B, write B, write A) and the stale write wins.
        try:
            fresh = stripe.Subscription.retrieve(object_id)
            deleted = False
        except stripe.error.InvalidRequestError as exc:
            if exc.http_status != 404:
                raise
            fresh, deleted = None, True

        if deleted:
            await conn.execute(
                text("""UPDATE stripe_subscriptions
                        SET deleted = true, status = 'canceled',
                            synced_at = now(), sync_version = sync_version + 1
                        WHERE id = :id"""),
                {"id": object_id})
        else:
            item = fresh["items"]["data"][0]
            await conn.execute(
                text("""
                    INSERT INTO stripe_subscriptions
                      (id, customer_id, status, price_id, quantity,
                       current_period_end, cancel_at_period_end, deleted,
                       sync_version, synced_at)
                    VALUES (:id, :cus, :status, :price, :qty, :cpe, :cape, false, 1, now())
                    ON CONFLICT (id) DO UPDATE SET
                      status = EXCLUDED.status,
                      price_id = EXCLUDED.price_id,
                      quantity = EXCLUDED.quantity,
                      current_period_end = EXCLUDED.current_period_end,
                      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                      deleted = false,
                      sync_version = stripe_subscriptions.sync_version + 1,
                      synced_at = now()
                """),
                {
                    "id": object_id,
                    "cus": fresh["customer"],
                    "status": fresh["status"],
                    "price": item["price"]["id"],
                    "qty": item.get("quantity", 1),
                    "cpe": datetime.fromtimestamp(item["current_period_end"], tz=timezone.utc)
                           if item.get("current_period_end") else None,
                    "cape": fresh["cancel_at_period_end"],
                },
            )

        row = (await conn.execute(
            text("SELECT * FROM stripe_subscriptions WHERE id = :id"), {"id": object_id}
        )).mappings().one()

        plan, access_until = derive_entitlement(row)

        await conn.execute(
            text("""
                INSERT INTO entitlements (account_id, plan, access_until, source_sub_id, updated_at)
                SELECT a.id, :plan, :until, :sub, now() FROM accounts a
                WHERE a.stripe_customer_id = :cus
                ON CONFLICT (account_id) DO UPDATE SET
                  plan = EXCLUDED.plan,
                  access_until = EXCLUDED.access_until,
                  source_sub_id = EXCLUDED.source_sub_id,
                  updated_at = now()
            """),
            {"plan": plan, "until": access_until, "sub": object_id, "cus": row["customer_id"]},
        )


# --------------------------------------------------------------------------
# 3. BUSINESS STATE — pure, no I/O, trivially testable
# --------------------------------------------------------------------------
PRICE_TO_PLAN = {"price_pro_monthly": "pro", "price_pro_yearly": "pro"}
GRACE = timedelta(days=3)


def derive_entitlement(m) -> tuple[str, datetime | None]:
    if m["deleted"]:
        return "free", None
    plan = PRICE_TO_PLAN.get(m["price_id"], "free")
    status = m["status"]
    if status in ("active", "trialing"):
        return plan, m["current_period_end"]
    if status in ("past_due", "unpaid"):
        return plan, (m["current_period_end"] + GRACE) if m["current_period_end"] else None
    return "free", None 
