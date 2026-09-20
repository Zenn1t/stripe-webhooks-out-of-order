#!/usr/bin/env bash
# Capture REAL event payloads once, pin them as golden files, test offline forever.
#
# Why not hand-write the JSON: hand-written samples never match your account's
# api_version, and the Event envelope has fields people forget (request.id,
# previous_attributes, pending_webhooks). Capture it, commit it, move on.
#
# Note: `stripe trigger` hits the real test-mode API and CREATES objects.
# It also cascades (payment_intent.succeeded also emits payment_intent.created),
# which is exactly the kind of sibling-event bundle that arrives out of order.
set -euo pipefail

OUT="${1:-./events.jsonl}"

stripe listen --print-json \
  --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,checkout.session.completed \
  > "$OUT" &
LISTEN_PID=$!
sleep 3

stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
stripe trigger invoice.payment_failed

sleep 5
kill "$LISTEN_PID"

echo "captured $(wc -l < "$OUT") events -> $OUT"

# Replaying one captured event against a running local endpoint, twice,
# is the official duplicate test. Nothing rate-limits it:
#   stripe events resend evt_xxx --webhook-endpoint=we_xxx
#   stripe events resend evt_xxx --webhook-endpoint=we_xxx
# (do NOT pass --idempotency, that suppresses the second send)
#
# Out-of-order against a LIVE local endpoint: resend in the order you want.
#   stripe events resend evt_deleted
#   stripe events resend evt_updated
# Stripe provides no way to force out-of-order natural delivery. This is it.
