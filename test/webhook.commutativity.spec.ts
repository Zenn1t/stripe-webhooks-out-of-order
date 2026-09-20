import request from 'supertest';
import { deliver, scenarios, sign, TEST_SECRET, FakeStripe } from './harness';
import { app, prisma, worker, reconciler, bootstrap, teardown, ACCOUNT } from './setup';
import { deriveEntitlement } from '../src/entitlement.rules';
import { handleNaively } from './naive.handler';

/**
 * The four tests that matter. Everything else in a webhook suite is decoration.
 *
 *   1. SIGNATURE   — a forged body is rejected.
 *   2. IDEMPOTENCE — the same event twice has the effect of once.
 *   3. COMMUTATIVITY — every ordering yields the same final state.
 *                      This is the one that catches the expensive bug, and it
 *                      is the one almost nobody writes.
 *   4. RECOVERY    — a dropped event is repaired by the reconciler.
 *
 * Note 2 and 3 are different properties. Teams dedup by event id, conclude
 * "we're idempotent", and ship — then a late customer.subscription.updated
 * carrying a stale `active` status resurrects a plan they already cancelled.
 * Idempotency is not commutativity.
 */

afterAll(teardown);

const SUB = 'sub_test_123';
const CUS = 'cus_test_123';

const ITEMS = { data: [{ price: { id: 'price_pro_monthly' }, quantity: 1, current_period_end: 1800000000 }] };

/**
 * Note these payloads are COMPLETE — price, quantity, period end, everything.
 * The naive handler below is not starved of data; it is given exactly what
 * Stripe sends and still gets the wrong answer. The defect is provenance,
 * not completeness.
 */
const lifecycle = [
  evt('evt_1', 'customer.subscription.created', { id: SUB, customer: CUS, status: 'incomplete', items: ITEMS, cancel_at_period_end: false }),
  evt('evt_2', 'customer.subscription.updated', { id: SUB, customer: CUS, status: 'active', items: ITEMS, cancel_at_period_end: false }),
  evt('evt_3', 'invoice.paid', { id: 'in_1', subscription: SUB }),
  evt('evt_4', 'customer.subscription.deleted', { id: SUB, customer: CUS, status: 'canceled', items: ITEMS, cancel_at_period_end: false, canceled_at: 1800000000 }),
];

/**
 * Stripe's final truth after that lifecycle: cancelled.
 *
 * Note it is a real object with `status: "canceled"`, not a 404. Cancelling a
 * subscription does not remove it — `subscriptions.retrieve` keeps returning
 * it. A 404 means the id never existed, which is a different failure and is
 * covered separately below.
 */
const timeline = [
  { customer: CUS, status: 'incomplete', items: { data: [{ price: { id: 'price_pro_monthly' }, quantity: 1, current_period_end: 1800000000 }] }, cancel_at_period_end: false, canceled_at: null },
  { customer: CUS, status: 'active',     items: { data: [{ price: { id: 'price_pro_monthly' }, quantity: 1, current_period_end: 1800000000 }] }, cancel_at_period_end: false, canceled_at: null },
  { customer: CUS, status: 'active',     items: { data: [{ price: { id: 'price_pro_monthly' }, quantity: 1, current_period_end: 1800000000 }] }, cancel_at_period_end: false, canceled_at: null },
  { customer: CUS, status: 'canceled',   items: { data: [{ price: { id: 'price_pro_monthly' }, quantity: 1, current_period_end: 1800000000 }] }, cancel_at_period_end: false, canceled_at: 1800000000 },
];

describe('stripe webhook ingress', () => {
  beforeEach(async () => { await bootstrap({ stripe: new FakeStripe(timeline) }); });

  it('1. rejects a body that does not match its signature', async () => {
    const body = JSON.stringify(lifecycle[0]);
    const res = await request(app.getHttpServer())
      .post('/stripe/webhook')
      .set('stripe-signature', sign(body, TEST_SECRET))
      .set('content-type', 'application/json')
      .send(body.replace('incomplete', 'active')); // tampered after signing

    expect(res.status).toBe(400);
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it('1b. rejects a stale timestamp (replay outside the 5-minute tolerance)', async () => {
    const body = JSON.stringify(lifecycle[0]);
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await request(app.getHttpServer())
      .post('/stripe/webhook')
      .set('stripe-signature', sign(body, TEST_SECRET, old))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe('2. idempotence — same event, delivered N times', () => {
  it.each([2, 3, 5])('%i deliveries produce one inbox row and one projection', async (n) => {
    const stripe = new FakeStripe(timeline, 'settled');
    const app = await bootstrap({ stripe });

    for (let i = 0; i < n; i++) {
      const res = await deliver(app, lifecycle[1]);
      // Every delivery must be 2xx. Returning 409 on a duplicate makes Stripe
      // retry it for three days.
      expect(res.status).toBe(200);
    }
    await worker.drain();

    expect(await prisma.stripeEvent.count({ where: { id: 'evt_2' } })).toBe(1);
    const mirror = await prisma.stripeSubscription.findUnique({ where: { id: SUB } });
    expect(mirror!.syncVersion).toBe(1n); // projected exactly once
  });
});

describe('3. commutativity — the test nobody writes', () => {
  // 4! orderings x 5 duplication variants = 120 scenarios, ~2s.
  for (const { name, sequence } of scenarios(lifecycle)) {
    it(`final state is identical for ${name}`, async () => {
      const stripe = new FakeStripe(timeline, 'settled');
      const app = await bootstrap({ stripe });

      for (const event of sequence) {
        expect((await deliver(app, event)).status).toBe(200);
      }
      await worker.drain();

      const ent = await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } });

      // Stripe's truth is: cancelled. No ordering, no duplicate, no late
      // delivery may produce anything else. A handler that writes
      // event.data.object fails exactly here, on the orderings where
      // `updated(active)` lands after `deleted`.
      expect(ent!.plan).toBe('free');
      expect(ent!.accessUntil).toBeNull();
    });
  }
});

describe('3b. commutativity when the object really is gone (404)', () => {
  // The other failure: retrieve() 404s. Stripe does this when the id never
  // existed, or for an object removed from a test-mode account. The mirror
  // must be marked deleted and access must drop — from any ordering.
  const gone = [...timeline.slice(0, 3), { deleted: true }];

  for (const { name, sequence } of scenarios(lifecycle).slice(0, 12)) {
    it(`revokes access for ${name}`, async () => {
      const stripe = new FakeStripe(gone, 'lagging');
      const app = await bootstrap({ stripe });

      // Grant first, so there is something to revoke.
      stripe.advance(1);
      await deliver(app, lifecycle[1]);
      await worker.drain();
      expect((await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } }))!.plan).toBe('pro');

      stripe.advance(3); // the object is now gone at Stripe
      for (const event of sequence) {
        expect((await deliver(app, event)).status).toBe(200);
      }
      await worker.drain();

      const ent = await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } });
      expect(ent!.plan).toBe('free');
      expect((await prisma.stripeSubscription.findUnique({ where: { id: SUB } }))!.deleted).toBe(true);
    });
  }
});

/**
 * THE CONTROL GROUP — same events, same rules, same database; the only
 * difference is that this handler trusts event.data.object instead of
 * re-fetching. Without this block the repo would merely assert that the naive
 * approach breaks. With it, the number is measured.
 */
describe('3c. the naive handler, measured', () => {
  beforeAll(async () => { await bootstrap({ stripe: new FakeStripe(timeline) }); });

  async function reset() {
    await prisma.$executeRawUnsafe('DELETE FROM entitlements');
    await prisma.$executeRawUnsafe('DELETE FROM stripe_subscriptions');
  }

  async function runNaive(sequence: any[]): Promise<string> {
    await reset();
    for (const event of sequence) await handleNaively(prisma as any, event);
    const ent = await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } });
    return ent?.plan ?? 'free';
  }

  it('is idempotent: replaying one event N times changes nothing', async () => {
    expect(await runNaive([lifecycle[1]])).toBe('pro');
    expect(await runNaive([lifecycle[1], lifecycle[1], lifecycle[1]])).toBe('pro');
  });

  it('reproduces the langfuse bug: a late `updated` resurrects a cancelled plan', async () => {
    // deleted lands first, then the delayed updated carrying status: "active".
    const plan = await runNaive([lifecycle[0], lifecycle[3], lifecycle[1]]);
    expect(plan).toBe('pro'); // WRONG: Stripe's truth is cancelled. Access is back, indefinitely.
  });

  it('gets the wrong answer on a large share of the 120 orderings', async () => {
    const all = scenarios(lifecycle);
    const broken: string[] = [];

    for (const { name, sequence } of all) {
      if ((await runNaive(sequence)) !== 'free') broken.push(name);
    }

    // eslint-disable-next-line no-console
    console.log(`naive handler: wrong final state on ${broken.length}/${all.length} orderings`);

    // 40, and the number is not arbitrary. The naive final state is decided by
    // whichever customer.subscription.* event happens to arrive LAST. Of the 24
    // permutations, 8 end with `updated(active)` last among the three
    // subscription events (24 / 3), and each permutation contributes 5
    // scenarios — the plain ordering plus four single-event duplicates, none of
    // which move the last event. 8 x 5 = 40.
    //
    // Idempotent, signature-checked, dedup'd — and wrong on a third of all
    // deliveries. The projector in section 3 is correct on all 120.
    expect(broken).toHaveLength(40);
    expect(broken.every((name) => name.includes('deleted'))).toBe(true);
  });
});

describe('4. recovery — an event that never arrived', () => {
  it('reconciler repairs state after a dropped deletion', async () => {
    const stripe = new FakeStripe(timeline, 'lagging');
    const app = await bootstrap({ stripe });

    stripe.advance(1); // Stripe truth: active
    await deliver(app, lifecycle[0]);
    await deliver(app, lifecycle[1]);
    await worker.drain();
    expect((await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } }))!.plan).toBe('pro');

    // The subscription is cancelled at Stripe and the webhook is LOST.
    stripe.advance(3);
    expect((await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } }))!.plan).toBe('pro'); // still wrong

    const drifted = await reconciler.fullSync();

    expect(drifted).toEqual([ACCOUNT]); // drift detected and reported
    expect((await prisma.entitlement.findUnique({ where: { accountId: ACCOUNT } }))!.plan).toBe('free');
  });
});

/** The business rules are pure, so they need no app at all. Test them directly. */
describe('entitlement rules (pure)', () => {
  it('never grants access on incomplete', () => {
    expect(deriveEntitlement({
      status: 'incomplete', priceId: 'price_pro_monthly',
      currentPeriodEnd: new Date(), cancelAtPeriodEnd: false, deleted: false,
    })).toEqual({ plan: 'free', accessUntil: null });
  });

  it('keeps access during dunning', () => {
    const end = new Date('2026-10-01T00:00:00Z');
    const r = deriveEntitlement({
      status: 'past_due', priceId: 'price_pro_monthly',
      currentPeriodEnd: end, cancelAtPeriodEnd: false, deleted: false,
    });
    expect(r.plan).toBe('pro');
    expect(r.accessUntil!.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });
});

function evt(id: string, type: string, object: Record<string, any>) {
  return {
    id, type, object: 'event', api_version: '2026-06-24.dahlia',
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object },
  };
}
