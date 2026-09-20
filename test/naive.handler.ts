import { PrismaClient } from '@prisma/client';
import { deriveEntitlement } from '../src/entitlement.rules';

/**
 * THE CONTROL GROUP.
 *
 * This is the handler almost everyone writes, and it is not a strawman: it
 * verifies the signature (upstream), dedups by event id (upstream), and derives
 * business state with the EXACT SAME pure function as the real projector.
 *
 * Exactly one thing differs: it writes `event.data.object` instead of
 * re-fetching the object from the API. That single difference is what the
 * commutativity suite measures.
 *
 * It is idempotent — replaying one event changes nothing. It is not
 * commutative, and the suite shows the orderings on which it silently
 * restores access to a cancelled subscription.
 */
export async function handleNaively(prisma: PrismaClient, event: any): Promise<void> {
  const obj = event.data.object;

  // Same scope as the real projector: subscription-shaped events only.
  if (!event.type.startsWith('customer.subscription.')) return;

  const item = obj.items?.data?.[0];
  const mirror = {
    customerId: obj.customer,
    status: event.type.endsWith('.deleted') ? 'canceled' : obj.status,
    priceId: item?.price?.id ?? null,
    quantity: item?.quantity ?? 1,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: obj.cancel_at_period_end ?? false,
    canceledAt: obj.canceled_at ? new Date(obj.canceled_at * 1000) : null,
    deleted: event.type.endsWith('.deleted'),
    syncedAt: new Date(),
  };

  await prisma.stripeSubscription.upsert({
    where: { id: obj.id },
    create: { id: obj.id, ...mirror, syncVersion: 1n },
    update: { ...mirror, syncVersion: { increment: 1 } },
  });

  const account = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM accounts WHERE stripeCustomerId = ${obj.customer} LIMIT 1
  `;
  if (!account[0]) return;

  // Identical rules, identical inputs shape. Only the provenance differs.
  const next = deriveEntitlement(mirror);

  await prisma.entitlement.upsert({
    where: { accountId: account[0].id },
    create: { accountId: account[0].id, ...next, sourceSubId: obj.id },
    update: { ...next, sourceSubId: obj.id },
  });
}
