import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SubscriptionProjector } from './subscription.projector';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;

/**
 * INBOX WORKER.
 *
 * Claims one unprocessed event at a time, per objectId, in receivedAt order.
 * The per-object serialisation is the point: two events about the same
 * subscription never run concurrently, so there is no interleaving to lose.
 *
 * Note what this does NOT do: it does not try to re-order events. Ordering
 * cannot be fixed at the transport layer — Stripe gives no sequence number
 * and explicitly says event.created (1-second resolution) must not be used
 * for ordering. Ordering is made irrelevant one layer down, in the projector.
 */
@Injectable()
export class InboxWorker {
  private readonly log = new Logger(InboxWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: SubscriptionProjector,
  ) {}

  /** Drain loop. Call from a cron, a BullMQ processor, or a test. */
  async drain(limit = 100): Promise<number> {
    let done = 0;
    for (let i = 0; i < limit; i++) {
      const claimed = await this.claimNext();
      if (!claimed) break;
      await this.process(claimed.id);
      done++;
    }
    return done;
  }

  /**
   * Claim the oldest unprocessed event whose objectId has no other
   * in-flight event. Expired leases are reclaimable (worker crashed).
   */
  private async claimNext(): Promise<{ id: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id
        FROM stripe_events e
        WHERE e.processedAt IS NULL
          AND e.attempts < ${MAX_ATTEMPTS}
          AND (e.claimedAt IS NULL OR e.claimedAt < DATE_SUB(NOW(3), INTERVAL ${LEASE_MS / 1000} SECOND))
          AND NOT EXISTS (
            SELECT 1 FROM stripe_events b
            WHERE b.objectId = e.objectId
              AND b.processedAt IS NULL
              AND b.claimedAt IS NOT NULL
              AND b.claimedAt >= DATE_SUB(NOW(3), INTERVAL ${LEASE_MS / 1000} SECOND)
          )
        ORDER BY e.receivedAt ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return null;

      await tx.stripeEvent.update({
        where: { id: rows[0].id },
        data: { claimedAt: new Date(), attempts: { increment: 1 } },
      });
      return rows[0];
    });
  }

  private async process(eventId: string): Promise<void> {
    const row = await this.prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } });

    try {
      await this.projector.project(row.objectId, row.type);

      await this.prisma.stripeEvent.update({
        where: { id: eventId },
        data: { processedAt: new Date(), claimedAt: null, lastError: null },
      });
    } catch (err: any) {
      // Leave processedAt NULL. Stripe already got its 200, so recovery is
      // ours: the lease expires and we retry. Never swallow silently.
      this.log.error(`event ${eventId} failed: ${err?.message}`);
      await this.prisma.stripeEvent.update({
        where: { id: eventId },
        data: { claimedAt: null, lastError: String(err?.stack ?? err).slice(0, 4000) },
      });
    }
  }
}
