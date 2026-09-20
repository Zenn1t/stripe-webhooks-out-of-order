
"""pytest version of the only test that matters."""
import hashlib
import hmac
import itertools
import json
import time

import pytest

SECRET = "whsec_test"


def sign(body: str, secret: str = SECRET, ts: int | None = None) -> str:
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def deliver(client, event):
    body = json.dumps(event)
    return client.post(
        "/stripe/webhook",
        content=body,
        headers={"stripe-signature": sign(body), "content-type": "application/json"},
    )


LIFECYCLE = [
    {"id": "evt_1", "type": "customer.subscription.created",
     "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "incomplete"}}},
    {"id": "evt_2", "type": "customer.subscription.updated",
     "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "active"}}},
    {"id": "evt_3", "type": "invoice.paid",
     "data": {"object": {"id": "in_1", "subscription": "sub_1"}}},
    {"id": "evt_4", "type": "customer.subscription.deleted",
     "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "canceled"}}},
]


def variants():
    """Every ordering, and for each ordering every single-event duplication."""
    for perm in itertools.permutations(LIFECYCLE):
        yield list(perm)
        for i in range(len(perm)):
            yield list(perm[: i + 1]) + [perm[i]] + list(perm[i + 1 :])


@pytest.mark.parametrize("sequence", list(variants()))
def test_final_state_is_order_independent(client, db, fake_stripe, sequence):
    """Stripe's truth is 'cancelled'. No permutation may produce anything else."""
    fake_stripe.settle()  # retrieve() returns the final object, as in production

    for event in sequence:
        assert deliver(client, event).status_code == 200
    drain_worker()

    ent = db.entitlement("acc_1")
    assert ent.plan == "free"
    assert ent.access_until is None


@pytest.mark.parametrize("n", [2, 3, 5])
def test_duplicate_delivery_projects_once(client, db, fake_stripe, n):
    for _ in range(n):
        assert deliver(client, LIFECYCLE[1]).status_code == 200
    drain_worker()

    assert db.event_count("evt_2") == 1
    assert db.subscription("sub_1").sync_version == 1


def test_tampered_body_is_rejected(client, db):
    body = json.dumps(LIFECYCLE[0])
    res = client.post(
        "/stripe/webhook",
        content=body.replace("incomplete", "active"),
        headers={"stripe-signature": sign(body), "content-type": "application/json"},
    )
    assert res.status_code == 400
    assert db.event_count() == 0
