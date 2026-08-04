import prisma from "../db.server";
import { BILLING_PLANS, getSubscription } from "./billing.server";
import { createLogger } from "../utils/logger.server";

const log = createLogger("UsageTracker");

/**
 * Get the current synced product count for a shop.
 */
export async function getSyncedProductCount(shopDomain: string): Promise<number> {
  const tracker = await prisma.usageTracker.findUnique({
    where: { shopDomain },
  });
  return tracker?.syncedProductCount ?? 0;
}

/**
 * Increment the synced product count.
 */
export async function incrementProductCount(shopDomain: string): Promise<void> {
  await prisma.usageTracker.upsert({
    where: { shopDomain },
    update: { syncedProductCount: { increment: 1 } },
    create: { shopDomain, syncedProductCount: 1 },
  });
}

/**
 * Recalculate the actual product count from ProductMapping table.
 * Use this to correct any drift.
 */
export async function recalculateProductCount(shopDomain: string): Promise<number> {
  // Find the store
  const store = await prisma.connectedStore.findFirst({
    where: { shopDomain, isBaseStore: true },
  });

  if (!store) return 0;

  // Count unique synced products where this store is the source
  const count = await prisma.productMapping.count({
    where: {
      sourceStoreId: store.id,
      status: "SYNCED",
      destProductGid: { not: null },
    },
  });

  await prisma.usageTracker.upsert({
    where: { shopDomain },
    update: { syncedProductCount: count },
    create: { shopDomain, syncedProductCount: count },
  });

  log.info(`Recalculated product count for ${shopDomain}: ${count}`);
  return count;
}

/**
 * Check if a store can sync more products based on their plan.
 */
export async function canSyncProduct(shopDomain: string): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  plan: string;
}> {
  const [subscription, tracker] = await Promise.all([
    getSubscription(shopDomain),
    prisma.usageTracker.findUnique({ where: { shopDomain } }),
  ]);

  const plan = subscription.plan;
  const current = tracker?.syncedProductCount ?? 0;
  const planLimit =
    BILLING_PLANS[plan].productLimit === Infinity
      ? 999999999
      : BILLING_PLANS[plan].productLimit;
  const limit = subscription.productLimit || planLimit;

  return {
    allowed: current < limit,
    current,
    limit: limit >= 999999999 ? -1 : limit, // -1 = unlimited
    plan,
  };
}
