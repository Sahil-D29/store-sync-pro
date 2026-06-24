import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  ProgressBar,
  IndexTable,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getDashboardAnalytics,
  getDailySyncCounts,
  getStoreSyncSummary,
} from "../services/analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [analytics, dailyCounts, storeSummary] = await Promise.all([
    getDashboardAnalytics(),
    getDailySyncCounts(7),
    getStoreSyncSummary(),
  ]);

  return json({ analytics, dailyCounts, storeSummary });
};

export default function AnalyticsPage() {
  const { analytics, dailyCounts, storeSummary } = useLoaderData<typeof loader>();

  const maxDailyCount = Math.max(
    ...dailyCounts.map((d: any) => d.success + d.failed),
    1
  );

  return (
    <Page>
      <TitleBar title="Analytics" />

      <BlockStack gap="500">
        {/* Overview Cards */}
        <InlineStack gap="400" wrap>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Connected Stores</Text>
              <Text as="p" variant="headingXl">{analytics.overview.totalStores}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Active Rules</Text>
              <Text as="p" variant="headingXl">{analytics.overview.activeRules}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Synced Products</Text>
              <Text as="p" variant="headingXl">{analytics.overview.totalProductMappings}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Synced Collections</Text>
              <Text as="p" variant="headingXl">{analytics.overview.totalCollectionMappings}</Text>
            </BlockStack>
          </Card>
        </InlineStack>

        {/* Time-based Stats */}
        <InlineStack gap="400" wrap>
          {[
            { label: "Last 24 Hours", data: analytics.last24h },
            { label: "Last 7 Days", data: analytics.last7d },
            { label: "Last 30 Days", data: analytics.last30d },
          ].map(({ label, data }) => (
            <Card key={label}>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{label}</Text>
                <InlineStack gap="400">
                  <Box>
                    <Text as="p" variant="bodySm" tone="subdued">Total</Text>
                    <Text as="p" variant="headingLg">{data.total}</Text>
                  </Box>
                  <Box>
                    <Text as="p" variant="bodySm" tone="subdued">Success</Text>
                    <Text as="p" variant="headingLg" tone="success">{data.success}</Text>
                  </Box>
                  <Box>
                    <Text as="p" variant="bodySm" tone="subdued">Failed</Text>
                    <Text as="p" variant="headingLg" tone="critical">{data.failed}</Text>
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm">Success Rate</Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">{data.successRate}%</Text>
                  </InlineStack>
                  <ProgressBar
                    progress={data.successRate}
                    tone={data.successRate >= 90 ? "success" : data.successRate >= 70 ? "highlight" : "critical"}
                    size="small"
                  />
                </BlockStack>
              </BlockStack>
            </Card>
          ))}
        </InlineStack>

        {/* Daily Sync Chart (text-based) */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Daily Sync Activity (Last 7 Days)</Text>
            {dailyCounts.map((day: any) => (
              <Box key={day.date}>
                <InlineStack gap="200" blockAlign="center">
                  <Box minWidth="90px">
                    <Text as="span" variant="bodySm">{day.date}</Text>
                  </Box>
                  <Box minWidth="200px">
                    <ProgressBar
                      progress={Math.round(((day.success + day.failed) / maxDailyCount) * 100)}
                      tone="success"
                      size="small"
                    />
                  </Box>
                  <InlineStack gap="100">
                    <Badge tone="success">{day.success}</Badge>
                    {day.failed > 0 && <Badge tone="critical">{day.failed}</Badge>}
                  </InlineStack>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        </Card>

        {/* Syncs by Resource Type */}
        <InlineStack gap="400" wrap>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">By Resource Type (7d)</Text>
              {Object.keys(analytics.syncsByResource).length === 0 ? (
                <Text as="p" tone="subdued">No data yet</Text>
              ) : (
                Object.entries(analytics.syncsByResource).map(([type, count]) => (
                  <InlineStack key={type} align="space-between">
                    <Text as="span">{type}</Text>
                    <Badge>{String(count)}</Badge>
                  </InlineStack>
                ))
              )}
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">By Trigger (7d)</Text>
              {Object.keys(analytics.syncsByTrigger).length === 0 ? (
                <Text as="p" tone="subdued">No data yet</Text>
              ) : (
                Object.entries(analytics.syncsByTrigger).map(([trigger, count]) => (
                  <InlineStack key={trigger} align="space-between">
                    <Text as="span">{trigger}</Text>
                    <Badge>{String(count)}</Badge>
                  </InlineStack>
                ))
              )}
            </BlockStack>
          </Card>
        </InlineStack>

        {/* Store Summary */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Store Overview</Text>
            {storeSummary.length === 0 ? (
              <Text as="p" tone="subdued">No connected stores yet.</Text>
            ) : (
              <IndexTable
                headings={[
                  { title: "Store" },
                  { title: "Role" },
                  { title: "Products" },
                  { title: "Collections" },
                  { title: "Sync Rules" },
                  { title: "Last Synced" },
                ]}
                itemCount={storeSummary.length}
                selectable={false}
              >
                {storeSummary.map((store: any, index: number) => (
                  <IndexTable.Row id={store.id} key={store.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {store.shopName || store.shopDomain}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={store.isBaseStore ? "info" : "attention"}>
                        {store.isBaseStore ? "Source" : "Destination"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{store.productMappings}</IndexTable.Cell>
                    <IndexTable.Cell>{store.collectionMappings}</IndexTable.Cell>
                    <IndexTable.Cell>{store.syncRules}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {store.lastSyncAt
                        ? new Date(store.lastSyncAt).toLocaleString()
                        : "Never"}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "../components/PageErrorBoundary";
