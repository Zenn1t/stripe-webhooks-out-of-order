import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { PrismaService } from './prisma.service';

/**
 * INGRESS. Does exactly three things and nothing else:
 *   1. verify the signature on the RAW body
 *   2. INSERT IGNORE into the inbox   (atomic dedup on evt_ id)
 *   3. return 200 fast
 *
 * No business logic here. Stripe docs: "Your endpoint must quickly return a
 * successful status code (2xx) before any complex logic that could cause a
 * timeout." A slow handler turns into a retry storm three days long.
 *
 * IMPORTANT: this route needs the raw body. In main.ts:
 *   app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
 * and DO NOT enable the global JSON body parser for this path, or the
 * signature will never verify.
 */
@Controller('stripe')
export class StripeWebhookController {
  private readonly log = new Logger(StripeWebhookController.name);
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  constructor(private readonly prisma: PrismaService) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    const raw = req.body as Buffer;

    let event: Stripe.Event;
    try {
      // Default tolerance is 300s. Never pass 0 — that disables the
      // recency check and re-opens replay attacks.
      event = this.stripe.webhooks.constructEvent(
        raw,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      // 400 here is correct: an unsigned request is not a delivery failure,
      // it is an attacker or a misconfigured secret.
      throw new BadRequestException('invalid signature');
    }

    const objectId = extractObjectId(event);

    // Atomic dedup. Prisma has no ON CONFLICT DO NOTHING for MySQL, so raw.
    // A duplicate delivery hits the PK, affects 0 rows, and we still 200 —
    // which is what stops Stripe's retry loop.
    await this.prisma.$executeRaw`
      INSERT IGNORE INTO stripe_events (id, type, objectId, apiVersion, payload, receivedAt, attempts)
      VALUES (${event.id}, ${event.type}, ${objectId}, ${event.api_version},
              ${JSON.stringify(event)}, NOW(3), 0)
    `;

    // Also create the lock row up front so the worker always has something
    // to SELECT ... FOR UPDATE, even for a brand-new object.
    await this.prisma.$executeRaw`
      INSERT IGNORE INTO sync_locks (objectId, updatedAt) VALUES (${objectId}, NOW(3))
    `;

    return { received: true };
  }
}

/**
 * The FIFO key. Everything about one Stripe object is processed serially.
 * For invoice/charge events we key on the *subscription* where there is one,
 * so `invoice.paid` and `customer.subscription.updated` for the same
 * subscription can never run concurrently.
 */
export function extractObjectId(event: Stripe.Event): string {
  const obj = event.data.object as Record<string, any>;

  if (event.type.startsWith('customer.subscription.')) return obj.id;
  if (event.type.startsWith('invoice.')) {
    return obj.subscription ?? obj.parent?.subscription_details?.subscription ?? obj.id;
  }
  if (event.type === 'checkout.session.completed') {
    return obj.subscription ?? obj.id;
  }
  return obj.id ?? event.id;
}
