import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  Button,
  Banner,
  Divider,
  IndexTable,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { cleanupOldLogs, getRetryStats } from "../services/retry-manager.server";
import { getAllExchangeRates, refreshAllExchangeRates } from "../services/currency.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [retryStats, exchangeRates, dbStats] = await Promise.all([
    getRetryStats(),
    getAllExchangeRates(),
    Promise.all([
      prisma.syncLog.count(),
      prisma.productMapping.count(),
      prisma.collectionMapping.count(),
      prisma.connectedStore.count({ where: { status: "ACTIVE" } }),
      prisma.syncRule.count({ where: { isActive: true } }),
    ]),
  ]);

  return json({
    appVersion: "1.0.0",
    apiVersion: "2025-01",
    retryStats,
    exchangeRates: exchangeRates.map((r) => ({
      ...r,
      fetchedAt: r.fetchedAt.toISOString(),
    })),
    dbStats: {
      totalLogs: dbStats[0],
      productMappings: dbStats[1],
      collectionMappings: dbStats[2],
      activeStores: dbStats[3],
      activeRules: dbStats[4],
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "cleanup-logs": {
      const days = parseInt(formData.get("days") as string) || 30;
      const deleted = await cleanupOldLogs(days);
      return json({ success: true, message: `Cleaned up ${deleted} old log entries` });
    }

    case "refresh-rates": {
      const result = await refreshAllExchangeRates();
      return json({
        success: true,
        message: `Refreshed ${result.refreshed} rates, ${result.errors} errors`,
      });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function SettingsPage() {
  const { appVersion, apiVersion, retryStats, exchangeRates, dbStats } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Page>
      <TitleBar title="Settings" />

      <BlockStack gap="500">
        {/* App Info */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              App Information
            </Text>
            <InlineStack gap="400">
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">App Version</Text>
                <Badge>{appVersion}</Badge>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Shopify API Version</Text>
                <Badge>{apiVersion}</Badge>
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Database Stats */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Database Overview
            </Text>
            <InlineStack gap="400" wrap>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Active Stores</Text>
                <Text as="p" variant="headingLg">{dbStats.activeStores}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Active Rules</Text>
                <Text as="p" variant="headingLg">{dbStats.activeRules}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Product Mappings</Text>
                <Text as="p" variant="headingLg">{dbStats.productMappings}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Collection Mappings</Text>
                <Text as="p" variant="headingLg">{dbStats.collectionMappings}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Total Sync Logs</Text>
                <Text as="p" variant="headingLg">{dbStats.totalLogs}</Text>
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Error Summary */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Error Summary
              </Text>
              <Badge tone={retryStats.totalFailed > 0 ? "critical" : "success"}>
                {`${retryStats.totalFailed} failed`}
              </Badge>
            </InlineStack>
            {retryStats.totalFailed > 0 ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  {retryStats.retrying} currently retrying
                </Text>
                {Object.entries(retryStats.failedByType).length > 0 && (
                  <InlineStack gap="200" wrap>
                    {Object.entries(retryStats.failedByType).map(([type, count]) => (
                      <Badge key={type} tone="attention">
                        {`${type}: ${count}`}
                      </Badge>
                    ))}
                  </InlineStack>
                )}
                <Button url="/app/retry-dashboard" size="slim">
                  View Retry Dashboard
                </Button>
              </BlockStack>
            ) : (
              <Text as="p" tone="subdued">No failed sync items. Everything is running smoothly.</Text>
            )}
          </BlockStack>
        </Card>

        {/* Webhook Status */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Webhook Status
            </Text>
            <Text as="p" variant="bodyMd">
              Webhooks are automatically registered when the app is installed.
            </Text>
            <InlineStack gap="200" wrap>
              <Badge tone="success">products/create</Badge>
              <Badge tone="success">products/update</Badge>
              <Badge tone="success">products/delete</Badge>
              <Badge tone="success">collections/create</Badge>
              <Badge tone="success">collections/update</Badge>
              <Badge tone="success">collections/delete</Badge>
              <Badge tone="success">inventory_levels/update</Badge>
              <Badge tone="success">bulk_operations/finish</Badge>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Exchange Rates */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Exchange Rates
              </Text>
              <Button
                size="slim"
                onClick={() => submit({ intent: "refresh-rates" }, { method: "POST" })}
                loading={isSubmitting}
              >
                Refresh All Rates
              </Button>
            </InlineStack>
            {exchangeRates.length === 0 ? (
              <Text as="p" tone="subdued">
                No exchange rates cached yet. Rates are fetched automatically
                when currency conversion price rules are used.
              </Text>
            ) : (
              <IndexTable
                headings={[
                  { title: "From" },
                  { title: "To" },
                  { title: "Rate" },
                  { title: "Last Fetched" },
                ]}
                itemCount={exchangeRates.length}
                selectable={false}
              >
                {exchangeRates.map((rate: any, index: number) => (
                  <IndexTable.Row id={rate.id} key={rate.id} position={index}>
                    <IndexTable.Cell>
                      <Badge>{rate.fromCurrency}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge>{rate.toCurrency}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {rate.rate.toFixed(4)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(rate.fetchedAt).toLocaleString()}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>

        {/* Maintenance */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Maintenance
            </Text>
            <Text as="p" variant="bodyMd">
              Clean up old sync logs to free up database space. Logs older than
              the specified number of days will be permanently deleted.
            </Text>
            <InlineStack gap="200">
              <Button
                size="slim"
                onClick={() =>
                  submit({ intent: "cleanup-logs", days: "30" }, { method: "POST" })
                }
                loading={isSubmitting}
              >
                Clean logs older than 30 days
              </Button>
              <Button
                size="slim"
                onClick={() =>
                  submit({ intent: "cleanup-logs", days: "7" }, { method: "POST" })
                }
                loading={isSubmitting}
              >
                Clean logs older than 7 days
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "../components/PageErrorBoundary";
