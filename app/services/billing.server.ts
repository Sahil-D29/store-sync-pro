import type { BillingPlan } from "@prisma/client";
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

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation CreateSubscription(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $trialDays: Int
    $test: Boolean
  ) {
    appSubscriptionCreate(
      name: $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
    ) {
      appSubscription {
        id
        status
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const CANCEL_SUBSCRIPTION_MUTATION = `#graphql
  mutation CancelSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GET_ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        lineItems {
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                price {
                  amount
                  currencyCode
                }
                interval
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Read the live managed-pricing subscription from Shopify (source of truth).
 * Returns the active subscription's name + status, or null when the merchant is
 * on the free plan / has no active charge. Used to keep the in-app "Current
 * Plan" accurate after a reinstall or a plan change made on Shopify's hosted
 * pricing page (req 1.2.2). Read-only and best-effort — never throws.
 */
export async function getLiveManagedPlan(
  admin: { graphql: (q: string) => Promise<Response> }
): Promise<{ name: string; status: string } | null> {
  try {
    const response = await admin.graphql(GET_ACTIVE_SUBSCRIPTIONS_QUERY);
    const result = await response.json();
    const subs = result?.data?.currentAppInstallation?.activeSubscriptions;
    if (Array.isArray(subs) && subs.length > 0 && subs[0]?.name) {
      return { name: subs[0].name, status: subs[0].status };
    }
    return null;
  } catch (e) {
    console.warn("[Billing] getLiveManagedPlan failed:", (e as Error).message);
    return null;
  }
}

/**
 * Get or create subscription record for a shop
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
 * Create a Shopify app subscription for a billing plan
 */
export async function createBillingSubscription(
  admin: any, // Shopify admin GraphQL client from authenticate
  shopDomain: string,
  plan: BillingPlan,
  returnUrl: string,
  isTest = false
): Promise<{ confirmationUrl: string | null; error: string | null }> {
  if (plan === "FREE") {
    // Downgrade to free: cancel existing subscription
    await cancelBillingSubscription(admin, shopDomain);
    await prisma.subscription.upsert({
      where: { shopDomain },
      update: {
        plan: "FREE",
        productLimit: BILLING_PLANS.FREE.productLimit,
        shopifyChargeGid: null,
        status: "ACTIVE",
      },
      create: {
        shopDomain,
        plan: "FREE",
        productLimit: BILLING_PLANS.FREE.productLimit,
        status: "ACTIVE",
      },
    });
    return { confirmationUrl: null, error: null };
  }

  const planConfig = BILLING_PLANS[plan];

  const response = await admin.graphql(CREATE_SUBSCRIPTION_MUTATION, {
    variables: {
      name: `Store Sync - ${planConfig.name}`,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: planConfig.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
      returnUrl,
      trialDays: planConfig.trialDays,
      test: isTest,
    },
  });

  const result = await response.json();
  const data = result.data?.appSubscriptionCreate;

  if (data?.userErrors?.length) {
    return { confirmationUrl: null, error: data.userErrors[0].message };
  }

  if (data?.appSubscription?.id) {
    await prisma.subscription.upsert({
      where: { shopDomain },
      update: {
        plan,
        productLimit:
          plan === "ENTERPRISE"
            ? 999999999
            : BILLING_PLANS[plan].productLimit,
        shopifyChargeGid: data.appSubscription.id,
        status:
          planConfig.trialDays > 0 ? "TRIAL" : "ACTIVE",
        trialEndsAt:
          planConfig.trialDays > 0
            ? new Date(
                Date.now() + planConfig.trialDays * 24 * 60 * 60 * 1000
              )
            : null,
      },
      create: {
        shopDomain,
        plan,
        productLimit:
          plan === "ENTERPRISE"
            ? 999999999
            : BILLING_PLANS[plan].productLimit,
        shopifyChargeGid: data.appSubscription.id,
        status:
          planConfig.trialDays > 0 ? "TRIAL" : "ACTIVE",
        trialEndsAt:
          planConfig.trialDays > 0
            ? new Date(
                Date.now() + planConfig.trialDays * 24 * 60 * 60 * 1000
              )
            : null,
      },
    });
  }

  return {
    confirmationUrl: data?.confirmationUrl || null,
    error: null,
  };
}

/**
 * Cancel existing Shopify subscription
 */
export async function cancelBillingSubscription(
  admin: any,
  shopDomain: string
): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { shopDomain },
  });

  if (subscription?.shopifyChargeGid) {
    try {
      await admin.graphql(CANCEL_SUBSCRIPTION_MUTATION, {
        variables: { id: subscription.shopifyChargeGid },
      });
    } catch {
      // Subscription may already be cancelled
    }
  }
}

/**
 * Check if shop can sync more products based on their plan
 */
export async function checkProductLimit(
  shopDomain: string,
  additionalCount = 1
): Promise<{ allowed: boolean; currentCount: number; limit: number; plan: BillingPlan }> {
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
    allowed: usage.syncedProductCount + additionalCount <= subscription.productLimit,
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
