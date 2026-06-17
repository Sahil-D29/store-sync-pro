import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  InlineGrid,
  Link,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useRouteError } from "@remix-run/react";
import { Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSubscription } from "../services/billing.server";
import { withDbRetry } from "../utils/db-retry.server";

const EMPTY_STATS = {
  connectedStores: 0,
  activeSyncRules: 0,
  successCount: 0,
  errorCount: 0,
  syncedProducts: 0,
  productLimit: 100,
  plan: "FREE",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      connectedStores,
      activeSyncRules,
      recentLogs,
      subscription,
      usage,
      successCount,
      errorCount,
    ] = await withDbRetry(() =>
      Promise.all([
        prisma.connectedStore.count({ where: { status: { not: "DISCONNECTED" } } }),
        prisma.syncRule.count({ where: { isActive: true } }),
        prisma.syncLog.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { syncRule: { select: { name: true } } },
        }),
        getSubscription(shopDomain),
        prisma.usageTracker.findUnique({ where: { shopDomain } }),
        prisma.syncLog.count({ where: { status: "SUCCESS", createdAt: { gte: dayAgo } } }),
        prisma.syncLog.count({ where: { status: "FAILED", createdAt: { gte: dayAgo } } }),
      ])
    );

    return {
      stats: {
        connectedStores,
        activeSyncRules,
        successCount,
        errorCount,
        syncedProducts: usage?.syncedProductCount ?? 0,
        productLimit: subscription.productLimit,
        plan: subscription.plan,
      },
      recentLogs: recentLogs.map((log) => ({
        id: log.id,
        action: log.action,
        resourceType: log.resourceType,
        status: log.status,
        trigger: log.trigger,
        message: log.message,
        errorDetail: log.errorDetail,
        ruleName: log.syncRule?.name,
        createdAt: log.createdAt.toISOString(),
      })),
      loadError: null as string | null,
    };
  } catch (e) {
    console.error("[Dashboard] Loader DB error:", (e as Error).message);
    return {
      stats: EMPTY_STATS,
      recentLogs: [] as Array<{
        id: string;
        action: string;
        resourceType: string;
        status: string;
        trigger: string;
        message: string | null;
        errorDetail: string | null;
        ruleName: string | undefined;
        createdAt: string;
      }>,
      loadError:
        "Couldn't load dashboard stats right now (temporary connection issue). Please reload.",
    };
  }
};

export default function Dashboard() {
  const { stats, recentLogs, loadError } = useLoaderData<typeof loader>();

  const usagePercent =
    stats.productLimit > 0 && stats.productLimit < 999999999
      ? Math.round((stats.syncedProducts / stats.productLimit) * 100)
      : 0;

  return (
    <Page>
      <TitleBar title="Store Sync Dashboard" />
      <BlockStack gap="500">
        {loadError && (
          <Banner tone="warning" title="Temporary issue">
            <p>{loadError}</p>
          </Banner>
        )}
        {usagePercent >= 80 && (
          <Banner
            title="Approaching product limit"
            tone="warning"
            action={{ content: "Upgrade Plan", url: "/app/billing" }}
          >
            <p>
              You've used {stats.syncedProducts} of {stats.productLimit}{" "}
              products on the {stats.plan} plan.
            </p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">
                Connected Stores
              </Text>
              <Text as="p" variant="headingXl">
                {stats.connectedStores}
              </Text>
              <Link url="/app/stores">Manage stores</Link>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">
                Active Sync Rules
              </Text>
              <Text as="p" variant="headingXl">
                {stats.activeSyncRules}
              </Text>
              <Link url="/app/sync-rules">Manage rules</Link>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">
                Synced (24h)
              </Text>
              <InlineStack gap="200" align="start">
                <Text as="p" variant="headingXl">
                  {stats.successCount}
                </Text>
                <Badge tone="success">success</Badge>
              </InlineStack>
              {stats.errorCount > 0 && (
                <InlineStack gap="200">
                  <Text as="span" variant="bodyMd" tone="critical">
                    {stats.errorCount} failed
                  </Text>
                </InlineStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">
                Product Usage
              </Text>
              <Text as="p" variant="headingXl">
                {stats.syncedProducts} / {stats.productLimit >= 999999999 ? "Unlimited" : stats.productLimit}
              </Text>
              <InlineStack gap="200">
                <Badge>{stats.plan}</Badge>
                <Link url="/app/billing">Change plan</Link>
              </InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Recent Sync Activity
                </Text>
                {recentLogs.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No sync activity yet. Connect stores and create sync rules
                    to get started.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {recentLogs.map((log) => (
                      <Box
                        key={log.id}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <InlineStack gap="300" blockAlign="center">
                            <Badge
                              tone={
                                log.status === "SUCCESS"
                                  ? "success"
                                  : log.status === "FAILED"
                                  ? "critical"
                                  : "attention"
                              }
                            >
                              {log.status}
                            </Badge>
                            <Text as="span" variant="bodyMd">
                              {log.action} {log.resourceType}
                            </Text>
                            {log.ruleName && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                via {log.ruleName}
                              </Text>
                            )}
                          </InlineStack>
                          <InlineStack gap="200">
                            <Badge tone="info">{log.trigger}</Badge>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {new Date(log.createdAt).toLocaleTimeString()}
                            </Text>
                          </InlineStack>
                        </InlineStack>
                        {log.errorDetail && (
                          <Box paddingBlockStart="100">
                            <Text as="p" variant="bodySm" tone="critical">
                              {log.errorDetail}
                            </Text>
                          </Box>
                        )}
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <TitleBar title="Store Sync Dashboard" />
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unexpected error loading the dashboard."}
          </Text>
          <Button url="/app">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
