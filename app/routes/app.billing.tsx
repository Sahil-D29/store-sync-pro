import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  InlineGrid,
  Divider,
  ProgressBar,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  BILLING_PLANS,
  getShopifyManagedPricingUrl,
  syncSubscriptionFromShopifyWithStatus,
} from "../services/billing.server";
import prisma from "../db.server";
import { withDbRetry } from "../utils/db-retry.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const url = new URL(request.url);
  const planHandleHint = url.searchParams.get("plan_handle");

  const plans = Object.entries(BILLING_PLANS).map(([key, plan]) => ({
    key,
    name: plan.name,
    price: plan.price,
    productLimit: plan.productLimit === Infinity ? "Unlimited" : String(plan.productLimit),
    trialDays: plan.trialDays,
  }));

  const managedPricingUrl = getShopifyManagedPricingUrl(shopDomain);

  try {
    const { subscription, warning } = await syncSubscriptionFromShopifyWithStatus(
      admin,
      shopDomain,
      planHandleHint
    );
    const usage = await withDbRetry(() =>
      prisma.usageTracker.findUnique({ where: { shopDomain } })
    );
    const planName =
      BILLING_PLANS[subscription.plan as keyof typeof BILLING_PLANS]?.name ||
      subscription.plan;

    return json({
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        productLimit: subscription.productLimit,
        trialEndsAt: subscription.trialEndsAt?.toISOString() || null,
        planName,
      },
      usage: { syncedProductCount: usage?.syncedProductCount ?? 0 },
      plans,
      managedPricingUrl,
      loadError: warning,
    });
  } catch (e) {
    console.error("[Billing] Loader DB error:", (e as Error).message);
    // Degrade gracefully to a default Free view so the page still renders.
    return json({
      subscription: {
        plan: "FREE",
        status: "ACTIVE",
        productLimit: BILLING_PLANS.FREE.productLimit,
        trialEndsAt: null,
        planName: BILLING_PLANS.FREE.name,
      },
      usage: { syncedProductCount: 0 },
      plans,
      managedPricingUrl,
      loadError:
        "Couldn't load your current subscription right now (temporary connection issue). Plan changes may be unavailable until you reload.",
    });
  }
};

export default function BillingPage() {
  const { subscription, usage, plans, loadError, managedPricingUrl } = useLoaderData<typeof loader>();

  const currentPlan = subscription.plan;
  const usagePercent =
    subscription.productLimit > 0 && subscription.productLimit < 999999999
      ? Math.round(
          (usage.syncedProductCount / subscription.productLimit) * 100
        )
      : 0;

  // Break out of the embedded iframe to Shopify's managed pricing page.
  // App Bridge intercepts window.open(..., "_top") and navigates the admin.
  const goToManagedPricing = () => {
    if (typeof window !== "undefined") {
      window.open(managedPricingUrl, "_top");
    }
  };

  return (
    <Page>
      <TitleBar title="Billing & Plans" />
      <BlockStack gap="500">
        {loadError && (
          <Banner tone="warning" title="Temporary issue">
            <p>{loadError}</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>
            Plans are managed by Shopify. Choosing a plan opens Shopify's secure
            pricing page, and your selection is confirmed automatically when you
            return.
          </p>
        </Banner>
        {/* Current Plan */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Current Plan
            </Text>
            <InlineStack gap="300" blockAlign="center">
              <Text as="p" variant="headingLg">
                {subscription.planName}
              </Text>
              <Badge tone={subscription.status === "ACTIVE" || subscription.status === "TRIAL" ? "success" : "attention"}>
                {subscription.status}
              </Badge>
              {subscription.trialEndsAt && (
                <Text as="span" variant="bodySm" tone="subdued">
                  Trial ends{" "}
                  {new Date(subscription.trialEndsAt).toLocaleDateString()}
                </Text>
              )}
            </InlineStack>

            <Divider />

            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text as="span" variant="bodyMd">
                  Products synced
                </Text>
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {usage.syncedProductCount} /{" "}
                  {subscription.productLimit >= 999999999
                    ? "Unlimited"
                    : subscription.productLimit}
                </Text>
              </InlineStack>
              {usagePercent > 0 && (
                <ProgressBar
                  progress={Math.min(usagePercent, 100)}
                  tone={usagePercent >= 90 ? "critical" : usagePercent >= 70 ? "highlight" : "primary"}
                  size="small"
                />
              )}
            </BlockStack>
          </BlockStack>
        </Card>

        {/* Plan Options */}
        <Text as="h2" variant="headingMd">
          Available Plans
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          {plans.map((plan: any) => {
            const isCurrent = plan.key === currentPlan;
            return (
              <Card key={plan.key}>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {plan.name}
                    </Text>
                    {isCurrent && <Badge tone="success">Current</Badge>}
                  </InlineStack>

                  <Text as="p" variant="headingXl">
                    ${plan.price}
                    <Text as="span" variant="bodySm" tone="subdued">
                      /month
                    </Text>
                  </Text>

                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      Up to {plan.productLimit} products
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Unlimited destination stores
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Real-time + scheduled sync
                    </Text>
                    {plan.trialDays > 0 && (
                      <Text as="p" variant="bodySm" tone="success">
                        {plan.trialDays}-day free trial
                      </Text>
                    )}
                  </BlockStack>

                  <Button
                    variant={isCurrent ? "secondary" : "primary"}
                    disabled={isCurrent}
                    onClick={goToManagedPricing}
                    fullWidth
                  >
                    {isCurrent
                      ? "Current Plan"
                      : plan.price === 0
                      ? "Downgrade"
                      : "Choose plan"}
                  </Button>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <TitleBar title="Billing & Plans" />
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unexpected error loading billing."}
          </Text>
          <Button url="/app/billing">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
