import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from './prisma.service';
import { deriveEntitlement } from './entitlement.rules';

/**
 * THE PROJECTOR — this is where out-of-order delivery stops mattering.
 *
 * Contract:
 *   project(objectId) is a PURE FUNCTION of Stripe's CURRENT state.
 *   It takes no payload. It cannot be given stale data, because it does not
 *   accept data at all — it goes and reads it.
 *
 * Consequences, and they are the whole design:
 *   - Replaying the same event twice  -> identical result. (idempotent)
 *   - Delivering events in any order  -> identical result. (commutative)
 *   - Losing an event entirely        -> the next event about that object,
 *                                        or the nightly reconciler, repairs it.
 *   - Stripe emitting TWO distinct evt_ ids for one logical change (documented
 *     behaviour) -> harmless, where event-id dedup alone would not help.
 *
 * The one thing you must not do is fetch outside the lock. If the API read
 * happens before the lock is taken, two workers can interleave
 * (fetch A, fetch B, write B, write A) and the old state wins. Fetch INSIDE.
 */
@Injectable()
export class SubscriptionProjector {
  private readonly log = new Logger(SubscriptionProjector.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('STRIPE') private readonly stripe: Stripe,
  ) {}

  async project(objectId: string, reason: string): Promise<void> {
    if (!objectId.startsWith('sub_')) {
      // Not a subscription-scoped event — resolve to a subscription first,
      // or handle in its own projector. Kept explicit rather than silent.
      this.log.debug(`skipping non-subscription object ${objectId} (${reason})`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Serialise on this object. Everything below runs alone.
      await tx.$executeRaw`SELECT objectId FROM sync_locks WHERE objectId = ${objectId} FOR UPDATE`;

      // 2. Read the truth from Stripe. Never from the event payload.
      const fresh = await this.fetchSubscription(objectId);

      // 3. Mirror payment state.
      if (fresh === null) {
        await tx.stripeSubscription.updateMany({
          where: { id: objectId },
          data: { deleted: true, status: 'canceled', syncedAt: new Date(), syncVersion: { increment: 1 } },
        });
      } else {
        const item = fresh.items.data[0];
        const data = {
          customerId: typeof fresh.customer === 'string' ? fresh.customer : fresh.customer.id,
          status: fresh.status,
          priceId: item?.price?.id ?? null,
          quantity: item?.quantity ?? 1,
          currentPeriodEnd: item?.current_period_end
            ? new Date(item.current_period_end * 1000)
            : null,
          cancelAtPeriodEnd: fresh.cancel_at_period_end,
          canceledAt: fresh.canceled_at ? new Date(fresh.canceled_at * 1000) : null,
          deleted: false,
          syncedAt: new Date(),
        };

        await tx.stripeSubscription.upsert({
          where: { id: objectId },
          create: { id: objectId, ...data, syncVersion: 1n },
          update: { ...data, syncVersion: { increment: 1 } },
        });
      }

      // 4. Recompute business state from payment state. Pure, total, testable.
      const mirror = await tx.stripeSubscription.findUnique({ where: { id: objectId } });
      if (!mirror) return;

      const accountId = await this.resolveAccountId(tx, mirror.customerId);
      if (!accountId) {
        this.log.warn(`no account mapped to customer ${mirror.customerId}`);
        return;
      }

      const next = deriveEntitlement(mirror);

      await tx.entitlement.upsert({
        where: { accountId },
        create: { accountId, ...next, sourceSubId: objectId },
        update: { ...next, sourceSubId: objectId },
      });
    });
  }

  /** 404 => the object is gone. Anything else is a real failure: rethrow. */
  private async fetchSubscription(id: string): Promise<Stripe.Subscription | null> {
    try {
      return await this.stripe.subscriptions.retrieve(id);
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  private async resolveAccountId(tx: any, customerId: string): Promise<string | null> {
    const row = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM accounts WHERE stripeCustomerId = ${customerId} LIMIT 1
    `;
    return row[0]?.id ?? null;
  }
}
