import type { BillingPlan, SubscriptionStatus } from "@prisma/client";
import prisma from "../db.server";

export const BILLING_PLANS = {
  FREE: {
    name: "Free",
    price: 0,
    productLimit: 100,
    trialDays: 0,
  },
  BASIC: {
    name: "Basic",
    price: 25,
    productLimit: 500,
    trialDays: 7,
  },
  PRO: {
    name: "Pro",
    price: 50,
    productLimit: 5000,
    trialDays: 7,
  },
  ENTERPRISE: {
    name: "Enterprise",
    price: 150,
    productLimit: Infinity,
    trialDays: 7,
  },
} as const;

const GET_SHOPIFY_BILLING_CONTEXT_QUERY = `#graphql
  query ShopifyBillingContext {
    shop {
      id
      myshopifyDomain
    }
    currentAppInstallation {
      app {
        id
      }
    }
  }
`;

const GET_ACTIVE_APP_PRICING_SUBSCRIPTION_QUERY = `#graphql
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle {
        endTime
      }
      items {
        handle
        description
        price {
          __typename
          active
        }
      }
      legacySubscriptionId
    }
  }
`;

const PLAN_HANDLE_ENV_KEYS: Record<BillingPlan, string> = {
  FREE: "SHOPIFY_PLAN_HANDLE_FREE",
  BASIC: "SHOPIFY_PLAN_HANDLE_BASIC",
  PRO: "SHOPIFY_PLAN_HANDLE_PRO",
  ENTERPRISE: "SHOPIFY_PLAN_HANDLE_ENTERPRISE",
};

type ShopifyAdminClient = {
  graphql: (q: string, options?: any) => Promise<Response>;
};

type ShopifyBillingContext = {
  shopId: string;
  shopDomain: string;
  appId: string;
};

type PartnerSubscriptionItem = {
  handle?: string | null;
  description?: string | null;
  price?: {
    active?: boolean | null;
  } | null;
};

type PartnerActiveSubscription = {
  trialEndsAt?: string | null;
  cancelAtEndOfCycle?: boolean | null;
  currentBillingCycle?: {
    endTime?: string | null;
  } | null;
  items?: PartnerSubscriptionItem[] | null;
  legacySubscriptionId?: string | null;
};

type SyncResult = {
  subscription: Awaited<ReturnType<typeof getSubscription>>;
  warning: string | null;
};

function productLimitForPlan(plan: BillingPlan): number {
  return plan === "ENTERPRISE" ? 999999999 : BILLING_PLANS[plan].productLimit;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function appPricingConfigWarning(): string | null {
  const missingRequired = [
    "SHOPIFY_PARTNER_ORG_ID",
    "SHOPIFY_PARTNER_ACCESS_TOKEN",
  ].filter((key) => !process.env[key]);

  if (missingRequired.length > 0) {
    return `Shopify App Pricing sync is not fully configured. Missing ${missingRequired.join(
      ", "
    )}.`;
  }

  const missingPlanHandles = Object.values(PLAN_HANDLE_ENV_KEYS).filter(
    (key) => !process.env[key]
  );
  const missingOptional = [
    !process.env.SHOPIFY_APP_HANDLE ? "SHOPIFY_APP_HANDLE" : null,
    ...missingPlanHandles,
  ].filter(Boolean);

  if (missingOptional.length > 0) {
    return `Shopify App Pricing is using fallback plan mapping. Set ${missingOptional.join(
      ", "
    )} for exact App Store review behavior.`;
  }

  return null;
}

export function getShopifyAppPricingConfigWarning(): string | null {
  return appPricingConfigWarning();
}

function getManagedPricingUrl(shopDomain: string): string {
  const shopHandle = shopDomain.replace(/\.myshopify\.com$/, "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "store-sync-auto";
  return `https://admin.shopify.com/store/${shopHandle}/charges/${appHandle}/pricing_plans`;
}

export function getShopifyManagedPricingUrl(shopDomain: string): string {
  return getManagedPricingUrl(shopDomain);
}

function normalizePlanHandle(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function planFromConfiguredHandle(handle: string | null | undefined): BillingPlan | null {
  const normalized = normalizePlanHandle(handle);
  if (!normalized) return null;

  for (const [plan, envKey] of Object.entries(PLAN_HANDLE_ENV_KEYS) as Array<
    [BillingPlan, string]
  >) {
    if (normalizePlanHandle(process.env[envKey]) === normalized) {
      return plan;
    }
  }

  return null;
}

function planFromFallbackText(value: string | null | undefined): BillingPlan | null {
  const normalized = normalizePlanHandle(value);
  if (!normalized) return null;

  if (normalized.includes("enterprise")) return "ENTERPRISE";
  if (normalized.includes("basic")) return "BASIC";
  if (/(^|[-_\s])pro($|[-_\s])/.test(normalized) || normalized.includes("professional")) {
    return "PRO";
  }
  if (normalized.includes("free")) return "FREE";

  return null;
}

function planFromShopifyPricing(
  handle: string | null | undefined,
  description?: string | null
): BillingPlan | null {
  return (
    planFromConfiguredHandle(handle) ||
    planFromFallbackText(handle) ||
    planFromFallbackText(description)
  );
}

function statusFromPartnerSubscription(
  subscription: PartnerActiveSubscription
): SubscriptionStatus {
  const trialEndsAt = parseDate(subscription.trialEndsAt);
  if (trialEndsAt && trialEndsAt.getTime() > Date.now()) {
    return "TRIAL";
  }

  return "ACTIVE";
}

async function getShopifyBillingContext(
  admin: ShopifyAdminClient
): Promise<ShopifyBillingContext> {
  const response = await admin.graphql(GET_SHOPIFY_BILLING_CONTEXT_QUERY);
  if (!response.ok) {
    throw new Error(`Shopify context query failed with ${response.status}`);
  }

  const result = await response.json();
  if (result?.errors?.length) {
    throw new Error(
      result.errors.map((error: { message?: string }) => error.message).join("; ")
    );
  }

  const shop = result?.data?.shop;
  const app = result?.data?.currentAppInstallation?.app;

  if (!shop?.id || !shop?.myshopifyDomain || !app?.id) {
    throw new Error("Shopify billing context response was incomplete");
  }

  return {
    shopId: shop.id,
    shopDomain: shop.myshopifyDomain,
    appId: app.id,
  };
}

async function queryPartnerActiveSubscription(
  context: ShopifyBillingContext
): Promise<PartnerActiveSubscription | null> {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const accessToken = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;

  if (!orgId || !accessToken) {
    throw new Error("Shopify Partner API credentials are not configured");
  }

  const response = await fetch(
    `https://partners.shopify.com/${orgId}/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: GET_ACTIVE_APP_PRICING_SUBSCRIPTION_QUERY,
        variables: {
          appId: context.appId,
          shopId: context.shopId,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Partner API billing query failed with ${response.status}`);
  }

  const result = await response.json();
  if (result?.errors?.length) {
    throw new Error(
      result.errors.map((error: { message?: string }) => error.message).join("; ")
    );
  }

  return result?.data?.activeSubscription || null;
}

function activeSubscriptionPlan(
  subscription: PartnerActiveSubscription,
  planHandleHint?: string | null
): { plan: BillingPlan | null; planHandle: string | null } {
  const items = subscription.items || [];
  const activeItem =
    items.find((item) => item?.price?.active !== false) || items[0] || null;

  const planHandle = activeItem?.handle || planHandleHint || null;
  const plan = planFromShopifyPricing(planHandle, activeItem?.description);

  return { plan, planHandle };
}

async function upsertFreeSubscription(
  shopDomain: string,
  context?: ShopifyBillingContext
) {
  return prisma.subscription.upsert({
    where: { shopDomain },
    update: {
      plan: "FREE",
      productLimit: BILLING_PLANS.FREE.productLimit,
      shopifyChargeGid: null,
      shopifyShopGid: context?.shopId || null,
      shopifyAppGid: context?.appId || null,
      planHandle: process.env.SHOPIFY_PLAN_HANDLE_FREE || "free",
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodEnd: null,
      lastSyncedAt: new Date(),
    },
    create: {
      shopDomain,
      plan: "FREE",
      productLimit: BILLING_PLANS.FREE.productLimit,
      shopifyShopGid: context?.shopId || null,
      shopifyAppGid: context?.appId || null,
      planHandle: process.env.SHOPIFY_PLAN_HANDLE_FREE || "free",
      status: "ACTIVE",
      lastSyncedAt: new Date(),
    },
  });
}

/**
 * Reconcile local subscription state with Shopify App Pricing.
 *
 * Shopify App Pricing changes happen on Shopify's hosted pricing page. The
 * Partner API activeSubscription query is the source of truth; a null active
 * subscription means the merchant is on the Free plan.
 */
export async function syncSubscriptionFromShopifyWithStatus(
  admin: ShopifyAdminClient,
  shopDomain: string,
  planHandleHint?: string | null
): Promise<SyncResult> {
  const configWarning = appPricingConfigWarning();

  try {
    const context = await getShopifyBillingContext(admin);
    const activeSubscription = await queryPartnerActiveSubscription(context);

    if (!activeSubscription) {
      const subscription = await upsertFreeSubscription(shopDomain, context);
      return { subscription, warning: configWarning };
    }

    const { plan, planHandle } = activeSubscriptionPlan(
      activeSubscription,
      planHandleHint
    );

    if (!plan) {
      const subscription = await getSubscription(shopDomain);
      return {
        subscription,
        warning:
          "Shopify returned an active pricing plan that this app could not map. Check SHOPIFY_PLAN_HANDLE_* configuration.",
      };
    }

    const trialEndsAt = parseDate(activeSubscription.trialEndsAt);
    const currentPeriodEnd = parseDate(
      activeSubscription.currentBillingCycle?.endTime
    );
    const status = statusFromPartnerSubscription(activeSubscription);

    const subscription = await prisma.subscription.upsert({
      where: { shopDomain },
      update: {
        plan,
        productLimit: productLimitForPlan(plan),
        shopifyChargeGid: activeSubscription.legacySubscriptionId || null,
        shopifyShopGid: context.shopId,
        shopifyAppGid: context.appId,
        planHandle,
        status,
        trialEndsAt,
        currentPeriodEnd,
        lastSyncedAt: new Date(),
      },
      create: {
        shopDomain,
        plan,
        productLimit: productLimitForPlan(plan),
        shopifyChargeGid: activeSubscription.legacySubscriptionId || null,
        shopifyShopGid: context.shopId,
        shopifyAppGid: context.appId,
        planHandle,
        status,
        trialEndsAt,
        currentPeriodEnd,
        lastSyncedAt: new Date(),
      },
    });

    return { subscription, warning: configWarning };
  } catch (e) {
    console.warn(
      "[Billing] Shopify App Pricing sync failed; keeping local subscription:",
      (e as Error).message
    );
    const subscription = await getSubscription(shopDomain);
    return {
      subscription,
      warning:
        configWarning ||
        "Couldn't confirm your current Shopify App Pricing subscription right now. Reload this page after returning from Shopify billing.",
    };
  }
}

export async function syncSubscriptionFromShopify(
  admin: ShopifyAdminClient,
  shopDomain: string,
  planHandleHint?: string | null
) {
  const result = await syncSubscriptionFromShopifyWithStatus(
    admin,
    shopDomain,
    planHandleHint
  );
  return result.subscription;
}

/**
 * Read the locally cached plan for surfaces that cannot query Shopify directly.
 */
export async function getSubscription(shopDomain: string) {
  let subscription = await prisma.subscription.findUnique({
    where: { shopDomain },
  });

  if (!subscription) {
    subscription = await prisma.subscription.create({
      data: {
        shopDomain,
        plan: "FREE",
        productLimit: BILLING_PLANS.FREE.productLimit,
        status: "ACTIVE",
      },
    });
  }

  return subscription;
}

/**
 * Check if shop can sync more products based on their cached Shopify App
 * Pricing plan.
 */
export async function checkProductLimit(
  shopDomain: string,
  additionalCount = 1
): Promise<{
  allowed: boolean;
  currentCount: number;
  limit: number;
  plan: BillingPlan;
}> {
  const subscription = await getSubscription(shopDomain);

  let usage = await prisma.usageTracker.findUnique({
    where: { shopDomain },
  });

  if (!usage) {
    usage = await prisma.usageTracker.create({
      data: { shopDomain, syncedProductCount: 0 },
    });
  }

  return {
    allowed:
      usage.syncedProductCount + additionalCount <= subscription.productLimit,
    currentCount: usage.syncedProductCount,
    limit: subscription.productLimit,
    plan: subscription.plan,
  };
}

/**
 * Increment synced product count
 */
export async function incrementProductCount(
  shopDomain: string,
  count = 1
): Promise<void> {
  await prisma.usageTracker.upsert({
    where: { shopDomain },
    update: {
      syncedProductCount: { increment: count },
      lastCountedAt: new Date(),
    },
    create: {
      shopDomain,
      syncedProductCount: count,
    },
  });
}

/**
 * Recalculate synced product count from ProductMapping table
 */
export async function recalculateProductCount(
  shopDomain: string
): Promise<number> {
  const count = await prisma.productMapping.count({
    where: {
      sourceStore: { shopDomain },
      status: "SYNCED",
    },
  });

  await prisma.usageTracker.upsert({
    where: { shopDomain },
    update: { syncedProductCount: count, lastCountedAt: new Date() },
    create: { shopDomain, syncedProductCount: count },
  });

  return count;
}
