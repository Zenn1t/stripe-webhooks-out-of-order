/**
 * BUSINESS STATE. A pure function — no I/O, no clock unless injected.
 *
 * "Stripe reports what happened. The backend decides what it means."
 * This file is the "decides what it means" part, and being pure is what
 * makes the whole system testable without a network.
 */
export interface PaymentMirror {
  status: string;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  deleted: boolean;
}

export interface EntitlementState {
  plan: string;
  accessUntil: Date | null;
}

const PRICE_TO_PLAN: Record<string, string> = {
  price_pro_monthly: 'pro',
  price_pro_yearly: 'pro',
  price_team_monthly: 'team',
};

/** Grace period for dunning. A past_due customer keeps access; a canceled one does not. */
const GRACE_DAYS = 3;

export function deriveEntitlement(m: PaymentMirror): EntitlementState {
  if (m.deleted) return { plan: 'free', accessUntil: null };

  const plan = (m.priceId && PRICE_TO_PLAN[m.priceId]) || 'free';

  switch (m.status) {
    case 'active':
    case 'trialing':
      return { plan, accessUntil: m.currentPeriodEnd };

    // Dunning. Stripe is retrying the card; do not cut access on the first failure.
    case 'past_due':
    case 'unpaid':
      return {
        plan,
        accessUntil: m.currentPeriodEnd
          ? new Date(m.currentPeriodEnd.getTime() + GRACE_DAYS * 86_400_000)
          : null,
      };

    // Payment never completed. Never grant on `incomplete`.
    case 'incomplete':
    case 'incomplete_expired':
    case 'canceled':
    case 'paused':
    default:
      return { plan: 'free', accessUntil: null };
  }
}
