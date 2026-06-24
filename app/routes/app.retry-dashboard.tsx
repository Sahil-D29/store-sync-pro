import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  Banner,
  Box,
  IndexTable,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import {
  getFailedSyncs,
  retrySyncItem,
  retryAllFailed,
  retryAllForRule,
  getRetryStats,
} from "../services/retry-manager.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const resourceType = url.searchParams.get("resourceType") || undefined;
  const syncRuleId = url.searchParams.get("syncRuleId") || undefined;

  const [failedSyncs, stats, syncRules] = await Promise.all([
    getFailedSyncs({ resourceType, syncRuleId, limit: 50 }),
    getRetryStats(),
    prisma.syncRule.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return json({ failedSyncs, stats, syncRules });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "retry-one": {
      const logId = formData.get("logId") as string;
      const result = await retrySyncItem(logId);
      return json(result);
    }

    case "retry-all": {
      const result = await retryAllFailed();
      return json({
        success: true,
        message: `Queued ${result.queued} retries, ${result.errors} errors`,
      });
    }

    case "retry-rule": {
      const syncRuleId = formData.get("syncRuleId") as string;
      const result = await retryAllForRule(syncRuleId);
      return json({
        success: true,
        message: `Queued ${result.queued} retries for rule, ${result.errors} errors`,
      });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function RetryDashboardPage() {
  const { failedSyncs, stats, syncRules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [filterRule, setFilterRule] = useState("");
  const [filterType, setFilterType] = useState("");

  return (
    <Page>
      <TitleBar title="Retry Dashboard" />

      <BlockStack gap="500">
        {/* Stats Overview */}
        <InlineStack gap="400" wrap>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Total Failed</Text>
              <Text as="p" variant="headingLg">{stats.totalFailed}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Currently Retrying</Text>
              <Text as="p" variant="headingLg">{stats.retrying}</Text>
            </BlockStack>
          </Card>
          {Object.entries(stats.failedByType).map(([type, count]) => (
            <Card key={type}>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{type}</Text>
                <Text as="p" variant="headingLg">{String(count)}</Text>
              </BlockStack>
            </Card>
          ))}
        </InlineStack>

        {/* Failed by Rule */}
        {stats.failedByRule.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Failed by Sync Rule</Text>
              {stats.failedByRule.map((rule: any) => (
                <InlineStack key={rule.ruleId} align="space-between" blockAlign="center">
                  <InlineStack gap="200">
                    <Text as="span" fontWeight="semibold">{rule.ruleName}</Text>
                    <Badge tone="critical">{`${rule.count} failed`}</Badge>
                  </InlineStack>
                  <Button
                    size="slim"
                    onClick={() =>
                      submit(
                        { intent: "retry-rule", syncRuleId: rule.ruleId },
                        { method: "POST" }
                      )
                    }
                    loading={isSubmitting}
                  >
                    Retry All
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        )}

        {/* Bulk Actions */}
        <Card>
          <InlineStack gap="400" blockAlign="center" align="space-between">
            <Text as="h2" variant="headingMd">
              Failed Sync Items ({failedSyncs.total})
            </Text>
            <InlineStack gap="200">
              <Button
                variant="primary"
                onClick={() => submit({ intent: "retry-all" }, { method: "POST" })}
                loading={isSubmitting}
                disabled={stats.totalFailed === 0}
              >
                {`Retry All Failed (${stats.totalFailed})`}
              </Button>
            </InlineStack>
          </InlineStack>
        </Card>

        {/* Failed Items Table */}
        {failedSyncs.items.length === 0 ? (
          <Banner tone="success">
            <p>No failed sync items. Everything is running smoothly!</p>
          </Banner>
        ) : (
          <Card padding="0">
            <IndexTable
              headings={[
                { title: "Time" },
                { title: "Rule" },
                { title: "Type" },
                { title: "Source GID" },
                { title: "Error" },
                { title: "Actions" },
              ]}
              itemCount={failedSyncs.items.length}
              selectable={false}
            >
              {failedSyncs.items.map((item: any, index: number) => (
                <IndexTable.Row id={item.id} key={item.id} position={index}>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm">
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm">
                      {item.ruleName || "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{item.resourceType}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm">
                      {item.sourceGid
                        ? item.sourceGid.replace(/gid:\/\/shopify\/\w+\//, "#")
                        : "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm" tone="critical">
                      {item.errorDetail
                        ? item.errorDetail.substring(0, 80) +
                          (item.errorDetail.length > 80 ? "..." : "")
                        : "Unknown error"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button
                      size="slim"
                      onClick={() =>
                        submit(
                          { intent: "retry-one", logId: item.id },
                          { method: "POST" }
                        )
                      }
                      loading={isSubmitting}
                    >
                      Retry
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "../components/PageErrorBoundary";
