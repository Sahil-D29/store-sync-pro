import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  InlineGrid,
  Box,
  Divider,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSubscription,
  createBillingSubscription,
  BILLING_PLANS,
} from "../services/billing.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [subscription, usage] = await Promise.all([
    getSubscription(shopDomain),
    prisma.usageTracker.findUnique({ where: { shopDomain } }),
  ]);

  const planName = BILLING_PLANS[subscription.plan as keyof typeof BILLING_PLANS]?.name || subscription.plan;

  return json({
    subscription: {
      plan: subscription.plan,
      status: subscription.status,
      productLimit: subscription.productLimit,
      trialEndsAt: subscription.trialEndsAt?.toISOString() || null,
      planName,
    },
    usage: {
      syncedProductCount: usage?.syncedProductCount ?? 0,
    },
    plans: Object.entries(BILLING_PLANS).map(([key, plan]) => ({
      key,
      name: plan.name,
      price: plan.price,
      productLimit: plan.productLimit === Infinity ? "Unlimited" : String(plan.productLimit),
      trialDays: plan.trialDays,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan") as string;

  if (!plan) {
    return json({ error: "Plan is required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/billing`;

  const result = await createBillingSubscription(
    admin,
    session.shop,
    plan as any,
    returnUrl,
    process.env.NODE_ENV !== "production" // Use test mode in dev
  );

  if (result.error) {
    return json({ error: result.error }, { status: 400 });
  }

  if (result.confirmationUrl) {
    return redirect(result.confirmationUrl);
  }

  return json({ success: true, message: "Plan updated" });
};

export default function BillingPage() {
  const { subscription, usage, plans } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const currentPlan = subscription.plan;
  const usagePercent =
    subscription.productLimit > 0 && subscription.productLimit < 999999999
      ? Math.round(
          (usage.syncedProductCount / subscription.productLimit) * 100
        )
      : 0;

  const handleSelectPlan = (planKey: string) => {
    submit({ plan: planKey }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Billing & Plans" />
      <BlockStack gap="500">
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
                    disabled={isCurrent || isSubmitting}
                    loading={isSubmitting}
                    onClick={() => handleSelectPlan(plan.key)}
                    fullWidth
                  >
                    {isCurrent
                      ? "Current Plan"
                      : plan.price === 0
                      ? "Downgrade"
                      : "Upgrade"}
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
