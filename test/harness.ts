import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * THE HARNESS. Three primitives, ~80 lines, no external service.
 *
 *   sign()     - produce a REAL Stripe-Signature header, so your verification
 *                code is exercised instead of bypassed. Tests that stub out
 *                signature checking leave the one security-critical branch
 *                untested.
 *   deliver()  - POST one captured event.
 *   scenarios()- expand a lifecycle into every ordering + duplication you care
 *                about. This is the part nobody writes by hand, and it is why
 *                reordering bugs survive code review.
 */

export const TEST_SECRET = 'whsec_test_secret_do_not_use_in_prod';

export function sign(body: string, secret = TEST_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  // Stripe's scheme: HMAC-SHA256 over `${timestamp}.${rawBody}`.
  // Only the v1 scheme is valid — ignore anything else to prevent downgrade.
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export async function deliver(app: INestApplication, event: unknown, opts: { secret?: string } = {}) {
  const body = JSON.stringify(event);
  return request(app.getHttpServer())
    .post('/stripe/webhook')
    .set('stripe-signature', sign(body, opts.secret))
    .set('content-type', 'application/json')
    .send(body);
}

/** All permutations of an array. Keep n <= 6 or the suite explodes (6! = 720). */
export function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

/** Every ordering, and for each ordering every single-event duplication. */
export function scenarios<T>(events: T[]): Array<{ name: string; sequence: T[] }> {
  const out: Array<{ name: string; sequence: T[] }> = [];

  for (const perm of permutations(events)) {
    const label = perm.map((e: any) => e.type ?? 'evt').join(' -> ');
    out.push({ name: `order: ${label}`, sequence: perm });

    perm.forEach((_, i) => {
      const dup = [...perm.slice(0, i + 1), perm[i], ...perm.slice(i + 1)];
      out.push({ name: `order: ${label} | duplicate #${i + 1}`, sequence: dup });
    });
  }
  return out;
}

/**
 * A fake Stripe API that behaves like the real one in the way that matters:
 * a retrieve() returns CURRENT state, not the state at the time of the event.
 *
 * mode 'settled'  - the lifecycle has finished at Stripe; every retrieve
 *                   returns the final object. This is reality for a delayed
 *                   webhook, and is what makes reordering harmless *if* your
 *                   handler refetches. Handlers that trust the payload fail here.
 * mode 'lagging'  - retrieve() returns the state as of step `cursor`, which you
 *                   advance manually. Use it to prove that a later event (or the
 *                   reconciler) repairs a temporarily wrong projection.
 */
export class FakeStripe {
  private cursor: number;

  constructor(
    private readonly timeline: Array<Record<string, any>>,
    private readonly mode: 'settled' | 'lagging' = 'settled',
  ) {
    this.cursor = mode === 'settled' ? timeline.length - 1 : 0;
  }

  advance(to?: number) {
    this.cursor = to ?? Math.min(this.cursor + 1, this.timeline.length - 1);
  }

  subscriptions = {
    retrieve: async (id: string) => {
      const state = this.timeline[this.cursor];
      if (!state || state.deleted) {
        const err: any = new Error('No such subscription');
        err.statusCode = 404;
        throw err;
      }
      return { ...state, id };
    },
  };

  events = { list: async function* () {} };
}
