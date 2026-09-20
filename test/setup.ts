import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import express from 'express';
import { PrismaService } from '../src/prisma.service';
import { StripeWebhookController } from '../src/webhook.controller';
import { SubscriptionProjector } from '../src/subscription.projector';
import { InboxWorker } from '../src/inbox.worker';
import { StripeReconciler } from '../src/reconciler.service';
import { FakeStripe, TEST_SECRET } from './harness';

export const ACCOUNT = 'acc_test_1';

export let app: INestApplication;
export let prisma: PrismaService;
export let worker: InboxWorker;
export let reconciler: StripeReconciler;

/**
 * Boots the real app with a fake Stripe client. Everything else — signature
 * verification, the inbox, the lock, the projector, Prisma — is production code.
 * Use a throwaway MariaDB (testcontainers or a scratch schema); do NOT mock
 * the database, since the dedup and the row lock ARE the implementation.
 */
export async function bootstrap(opts: { stripe: FakeStripe }): Promise<INestApplication> {
  // Each scenario gets a fresh app; the suite runs 120+ of them, so the
  // previous one has to go or the connection pool is exhausted mid-run.
  await teardown();

  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

  const moduleRef = await Test.createTestingModule({
    controllers: [StripeWebhookController],
    providers: [
      PrismaService,
      SubscriptionProjector,
      InboxWorker,
      StripeReconciler,
      { provide: 'STRIPE', useValue: opts.stripe },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  // The raw body is mandatory for signature verification.
  app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
  await app.init();

  prisma = moduleRef.get(PrismaService);
  worker = moduleRef.get(InboxWorker);
  reconciler = moduleRef.get(StripeReconciler);

  await prisma.$executeRawUnsafe('DELETE FROM stripe_events');
  await prisma.$executeRawUnsafe('DELETE FROM entitlements');
  await prisma.$executeRawUnsafe('DELETE FROM stripe_subscriptions');
  await prisma.$executeRawUnsafe('DELETE FROM sync_locks');
  await prisma.$executeRawUnsafe(
    `INSERT INTO accounts (id, stripeCustomerId) VALUES ('${ACCOUNT}', 'cus_test_123')
     ON DUPLICATE KEY UPDATE stripeCustomerId = VALUES(stripeCustomerId)`,
  );

  return app;
}

/** Close the app (and its Prisma pool) if one is running. */
export async function teardown(): Promise<void> {
  if (app) {
    await app.close();
    app = undefined as unknown as INestApplication;
  }
}
