# stripe-webhooks-out-of-order

How to make a Stripe webhook handler survive **duplicate events, out-of-order
delivery and dropped events** — and how to test that it does. A reference
implementation plus a test harness that replays every ordering of a
subscription lifecycle against your endpoint with valid signatures.
NestJS + Prisma + MariaDB in `src/`, FastAPI + SQLAlchemy in `python/`.

Companion code to the article
[Stripe integration](https://www.reshetov.ch/solutions/stripe-integration-bern).

## Quick start

```bash
git clone https://github.com/Zenn1t/stripe-webhooks-out-of-order
cd stripe-webhooks-out-of-order
npm install
npm run db:up      # throwaway MariaDB on :3307 via docker compose
npm test           # 143 passing, ~30s
```

The suite talks to a real database on purpose: the atomic dedup and the row
lock *are* the implementation, so mocking it would test nothing. Tear down with
`npm run db:down`.

## The problem

Stripe guarantees neither ordering nor exactly-once delivery, and both obvious
workarounds are wrong:

- **`event.created` is not an ordering key.** One-second resolution, so sibling
  events routinely share a timestamp; Stripe's docs say not to order by it. A
  "drop anything older than the last `created`" guard accepts stale writes.
- **Deduping on `event.id` is not enough.** Stripe can emit two distinct `evt_`
  objects for one logical change, and a unique index will not catch that pair.

The production failure: `customer.subscription.deleted` arrives and access is
revoked, then a delayed `customer.subscription.updated` arrives with an older
snapshot saying `status: "active"`, and a handler that trusts the payload
restores the plan permanently. **The suite measures this: the naive handler
gets the wrong final state on 40 of 120 orderings.** The distinction underneath is that **idempotence
is not commutativity** — idempotence means the same event twice equals once,
commutativity means any order yields the same state. Dedup buys the first; the
bugs live in the second.

## How it works

```
Stripe event ──► ① INBOX       verify signature, INSERT IGNORE(evt_id), 200
                     ▼          (transport only — zero business logic)
                 ② WORKER      claim per objectId, strictly serial (FIFO per object)
                     ▼
                 ③ PROJECTOR   LOCK(object) → RE-FETCH from Stripe API
                     ▼           → mirror payment state → derive entitlement (pure)
                 ④ RECONCILER  /v1/events catch-up + nightly full sync, repairs drift
```

The payload is never read for state — only `type` and `data.object.id` — and the
object itself is re-fetched inside the lock. That one constraint buys everything:
any order converges (commutative), duplicates converge (idempotent), two `evt_`
ids for one change are harmless, and a lost event is repaired by the next event
or by the reconciler.

## Rules that actually matter

- **Fetch inside the lock.** `SELECT … FOR UPDATE` on `sync_locks`, then
  `retrieve`, then write, in one transaction. Fetching first lets two workers
  interleave (fetch A, fetch B, write B, write A) and the stale write wins —
  the same bug, now in your own code.
- **Dedup atomically in the database**, via `INSERT IGNORE` / `ON CONFLICT DO
  NOTHING` on a unique key. `SELECT`-then-`INSERT` loses to concurrent retries:
  both pass the check, both insert.
- **Return 200 on a duplicate, not 409** — a non-2xx puts the event back into
  Stripe's retry schedule, which runs up to three days.
- **Verify on the raw body.** Disable the global JSON parser for that route,
  and never set signature tolerance to 0.
- **Keep business rules pure** (`entitlement.rules.ts`): mirror in, entitlement
  out, no I/O — testable without a network or a database.
- **Build the nightly full sync even if you build nothing else.** It is the
  difference between assuming the webhooks were right and knowing.

## Testing

Stripe's CLI cannot force out-of-order delivery, so the harness generates it.
`test/harness.ts` is three primitives:

```ts
sign(body, secret, ts)   // a real Stripe-Signature: HMAC-SHA256("${ts}.${body}")
deliver(app, event)      // POST with a valid signature
scenarios(events)        // every permutation × every single-event duplicate
```

A real signature is the point: a harness that disables verification leaves the
only security-critical branch uncovered. The suite covers signature rejection (forged body, stale timestamp),
idempotence, commutativity and recovery from a dropped event. The commutativity
test expands one four-event lifecycle into 120 scenarios — every permutation,
each with every single-event duplicate. 143 tests, ~30s.

It also runs a **control group** (`test/naive.handler.ts`): the handler most
people write, which verifies the signature, dedups by event id and derives
state with the *same pure rules* — and differs in one respect only, writing
`event.data.object` instead of re-fetching. It is idempotent. It is wrong on
40 of the same 120 orderings, and the number is derived in the test rather than
observed: the naive result is decided by whichever subscription event lands
last, 8 of 24 permutations end with `updated(active)`, and each contributes 5
scenarios. The projector in `src/` is correct on all 120.

`FakeStripe` matches the real API in the way that decides the outcome:
`retrieve()` returns **current** state, not state as of the event. It also
models cancellation the way Stripe actually does it — a cancelled subscription
still retrieves, with `status: "canceled"`; a 404 means the id never existed,
which is a separate path with its own tests.

Capture real payloads once with `fixtures/capture.sh` and run offline;
hand-written JSON drifts from your account's `api_version`. Against a live
endpoint, `stripe events resend evt_xxx --webhook-endpoint=we_xxx` is the only
way to force duplicates and a chosen order — but not with `--idempotency`, which
suppresses the repeat.

## Layout

`prisma/schema.prisma` holds the three state layers plus `sync_locks` and the
reconciler cursor. In `src/`: `webhook.controller.ts` (ingress),
`inbox.worker.ts` (per-object claim, leases, retries),
`subscription.projector.ts` (lock → refetch → mirror → derive — the core),
`entitlement.rules.ts` (pure rules), `reconciler.service.ts` (catch-up and
nightly full sync). In `test/`: `harness.ts` and the spec. `python/` ports the
ingress, projector and rules to FastAPI + SQLAlchemy; the worker and the
reconciler are Node-only.

Adapt freely: table names, the `customer → account` mapping and the DI wiring
are yours. What cannot change without breaking the design is atomic dedup,
fetching inside the lock, and never reading the payload in business logic.

MIT licensed.
