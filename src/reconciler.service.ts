import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from './prisma.service';
import { SubscriptionProjector } from './subscription.projector';
import { extractObjectId } from './webhook.controller';

/**
 * RECONCILER. The layer that handles the failure mode no amount of
 * idempotency can fix: an event that never arrived at all.
 *
 * Two jobs:
 *   catchUp()  — every ~15 min. Pulls events Stripe failed to deliver.
 *                `ending_before` + auto-pagination is the ONE place Stripe
 *                returns events in chronological order.
 *   fullSync() — nightly. Re-projects every non-terminal subscription,
 *                which repairs drift from any cause, including our own bugs.
 *
 * If you only build one thing from this repo, build fullSync(). It is what
 * turns "we hope the webhooks were right" into "we checked".
 */
@Injectable()
export class StripeReconciler {
  private readonly log = new Logger(StripeReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('STRIPE') private readonly stripe: Stripe,
    private readonly projector: SubscriptionProjector,
  ) {}

  /** Cron: every 15 minutes. */
  async catchUp(): Promise<number> {
    const cursor = await this.prisma.reconcilerCursor.upsert({
      where: { id: 'stripe' },
      create: { id: 'stripe' },
      update: {},
    });

    let count = 0;
    let newest: string | null = null;

    const params: Stripe.EventListParams = {
      limit: 100,
      delivery_success: false,
      ...(cursor.lastEventId ? { ending_before: cursor.lastEventId } : {}),
    };

    for await (const event of this.stripe.events.list(params)) {
      newest = newest ?? event.id;

      // Same inbox, same dedup. An event that ALSO arrives by webhook later
      // hits the PK and is ignored — catch-up and delivery cannot double-apply.
      const objectId = extractObjectId(event);
      await this.prisma.$executeRaw`
        INSERT IGNORE INTO sync_locks (objectId, updatedAt) VALUES (${objectId}, NOW(3))
      `;
      await this.prisma.$executeRaw`
        INSERT IGNORE INTO stripe_events (id, type, objectId, apiVersion, payload, receivedAt, attempts)
        VALUES (${event.id}, ${event.type}, ${objectId}, ${event.api_version},
                ${JSON.stringify(event)}, NOW(3), 0)
      `;
      count++;
    }

    if (newest) {
      await this.prisma.reconcilerCursor.update({
        where: { id: 'stripe' },
        data: { lastEventId: newest, lastRunAt: new Date() },
      });
    }

    if (count) this.log.warn(`catch-up pulled ${count} undelivered events`);
    return count;
  }

  /**
   * Cron: nightly. Re-project everything and report drift.
   * Returns the list of accounts whose entitlement CHANGED — that number
   * should be 0. Alert on it. A non-zero count is your webhook layer lying.
   */
  async fullSync(): Promise<string[]> {
    const subs = await this.prisma.stripeSubscription.findMany({
      where: { deleted: false },
      select: { id: true },
    });

    const drifted: string[] = [];

    for (const { id } of subs) {
      const before = await this.prisma.entitlement.findFirst({ where: { sourceSubId: id } });
      await this.projector.project(id, 'reconciler.fullSync');
      const after = await this.prisma.entitlement.findFirst({ where: { sourceSubId: id } });

      if (
        before?.plan !== after?.plan ||
        before?.accessUntil?.getTime() !== after?.accessUntil?.getTime()
      ) {
        drifted.push(after?.accountId ?? id);
        this.log.error(
          `DRIFT ${id}: ${before?.plan}/${before?.accessUntil} -> ${after?.plan}/${after?.accessUntil}`,
        );
      }
    }

    return drifted;
  }
}
