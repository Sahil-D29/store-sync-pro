import { useState } from "react";
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
  Button,
  Select,
  Banner,
  ProgressBar,
  IndexTable,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { startBulkProductExport, getBulkOperations } from "../services/bulk-operations.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [syncRules, operations] = await Promise.all([
    prisma.syncRule.findMany({
      where: { isActive: true },
      include: {
        sourceStore: { select: { shopDomain: true, shopName: true } },
        destStore: { select: { shopDomain: true, shopName: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    getBulkOperations(),
  ]);

  return json({
    syncRules: syncRules.map((r) => ({
      id: r.id,
      name: r.name,
      sourceStore: r.sourceStore.shopName || r.sourceStore.shopDomain,
      destStore: r.destStore.shopName || r.destStore.shopDomain,
    })),
    operations: operations.map((op) => ({
      ...op,
      startedAt: op.startedAt.toISOString(),
      completedAt: op.completedAt?.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "start-bulk-export": {
      const syncRuleId = formData.get("syncRuleId") as string;
      if (!syncRuleId) {
        return json({ error: "Please select a sync rule" }, { status: 400 });
      }

      const result = await startBulkProductExport(syncRuleId);
      if (!result.success) {
        return json({ error: result.error }, { status: 400 });
      }
      return json({ success: true, bulkOperationGid: result.bulkOperationGid });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function BulkSyncPage() {
  const { syncRules, operations } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedRuleId, setSelectedRuleId] = useState("");

  const handleStartBulkExport = () => {
    submit(
      { intent: "start-bulk-export", syncRuleId: selectedRuleId },
      { method: "POST" }
    );
  };

  const getStatusTone = (status: string) => {
    switch (status) {
      case "COMPLETED":
        return "success" as const;
      case "RUNNING":
      case "CREATED":
        return "info" as const;
      case "FAILED":
      case "CANCELED":
        return "critical" as const;
      default:
        return "attention" as const;
    }
  };

  return (
    <Page>
      <TitleBar title="Bulk Sync" />

      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Bulk sync uses Shopify's Bulk Operations API to export all products
            from the source store. This is ideal for initial full catalog sync
            or re-syncing large numbers of products.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Start Bulk Export
            </Text>
            <InlineStack gap="400" blockAlign="end">
              <Box minWidth="300px">
                <Select
                  label="Sync rule"
                  options={[
                    { label: "Select a sync rule...", value: "" },
                    ...syncRules.map((r: any) => ({
                      label: `${r.name} (${r.sourceStore} → ${r.destStore})`,
                      value: r.id,
                    })),
                  ]}
                  value={selectedRuleId}
                  onChange={setSelectedRuleId}
                />
              </Box>
              <Button
                variant="primary"
                onClick={handleStartBulkExport}
                loading={isSubmitting}
                disabled={!selectedRuleId}
              >
                Start Bulk Export
              </Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              This will create a bulk operation on Shopify to export all
              products. When complete, each product will be queued for sync.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Recent Bulk Operations
            </Text>

            {operations.length === 0 ? (
              <Text as="p" tone="subdued">
                No bulk operations yet.
              </Text>
            ) : (
              <IndexTable
                headings={[
                  { title: "Store" },
                  { title: "Purpose" },
                  { title: "Status" },
                  { title: "Objects" },
                  { title: "Started" },
                  { title: "Completed" },
                ]}
                itemCount={operations.length}
                selectable={false}
              >
                {operations.map((op: any, index: number) => (
                  <IndexTable.Row id={op.id} key={op.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">
                        {op.shopDomain}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge>{op.purpose}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={getStatusTone(op.status)}>
                        {op.status}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {op.objectCount ?? "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(op.startedAt).toLocaleString()}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {op.completedAt
                        ? new Date(op.completedAt).toLocaleString()
                        : "—"}
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
