import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Box,
  Select,
  IndexTable,
  Pagination,
  Filters,
  Button,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncProduct } from "../services/product-sync.server";
import { createClientForStore } from "../services/shopify-client.server";

const PAGE_SIZE = 25;

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "retry": {
      const logId = formData.get("logId") as string;
      const log = await prisma.syncLog.findUnique({
        where: { id: logId },
        include: {
          syncRule: {
            include: { sourceStore: true, destStore: true, priceRule: true },
          },
        },
      });

      if (!log?.syncRule || !log.sourceGid) {
        return json({ error: "Log entry not found or missing data" }, { status: 400 });
      }

      try {
        const sourceClient = await createClientForStore(log.syncRule.sourceStoreId);
        const destClient = await createClientForStore(log.syncRule.destStoreId);

        const result = await syncProduct(
          log.syncRule as any,
          log.sourceGid,
          sourceClient,
          destClient
        );

        await prisma.syncLog.create({
          data: {
            syncRuleId: log.syncRule.id,
            storeId: log.syncRule.destStoreId,
            action: result.action,
            resourceType: log.resourceType,
            sourceGid: result.sourceGid,
            destGid: result.destGid,
            status: result.success ? "SUCCESS" : "FAILED",
            trigger: "RETRY",
            message: `Retry of ${logId}`,
            errorDetail: result.error,
            duration: result.duration,
          },
        });

        return json({ success: true, retryResult: result.success ? "SUCCESS" : "FAILED" });
      } catch (error) {
        return json({ error: (error as Error).message }, { status: 400 });
      }
    }

    case "clear-old": {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const deleted = await prisma.syncLog.deleteMany({
        where: { createdAt: { lt: thirtyDaysAgo } },
      });
      return json({ success: true, deleted: deleted.count });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const status = url.searchParams.get("status") || "";
  const resourceType = url.searchParams.get("resourceType") || "";
  const trigger = url.searchParams.get("trigger") || "";

  const where: any = {};
  if (status) where.status = status;
  if (resourceType) where.resourceType = resourceType;
  if (trigger) where.trigger = trigger;

  const [logs, totalCount] = await Promise.all([
    prisma.syncLog.findMany({
      where,
      include: {
        syncRule: { select: { name: true } },
        store: { select: { shopDomain: true, shopName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.syncLog.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return json({
    logs: logs.map((log) => ({
      id: log.id,
      action: log.action,
      resourceType: log.resourceType,
      sourceGid: log.sourceGid,
      destGid: log.destGid,
      status: log.status,
      trigger: log.trigger,
      message: log.message,
      errorDetail: log.errorDetail,
      duration: log.duration,
      ruleName: log.syncRule?.name,
      storeName: log.store?.shopName || log.store?.shopDomain,
      createdAt: log.createdAt.toISOString(),
    })),
    pagination: {
      page,
      totalPages,
      totalCount,
    },
  });
};

export default function LogsPage() {
  const { logs, pagination } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const currentStatus = searchParams.get("status") || "";
  const currentResourceType = searchParams.get("resourceType") || "";
  const currentTrigger = searchParams.get("trigger") || "";

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.set("page", "1");
    setSearchParams(params);
  };

  const clearFilters = () => {
    setSearchParams({ page: "1" });
  };

  const goToPage = (page: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(page));
    setSearchParams(params);
  };

  const statusBadgeTone = (status: string) => {
    switch (status) {
      case "SUCCESS":
        return "success";
      case "FAILED":
        return "critical";
      case "PARTIAL":
        return "warning";
      case "SKIPPED":
        return "attention";
      case "RETRYING":
        return "info";
      default:
        return undefined;
    }
  };

  const appliedFilters = [];
  if (currentStatus) {
    appliedFilters.push({
      key: "status",
      label: `Status: ${currentStatus}`,
      onRemove: () => updateFilter("status", ""),
    });
  }
  if (currentResourceType) {
    appliedFilters.push({
      key: "resourceType",
      label: `Type: ${currentResourceType}`,
      onRemove: () => updateFilter("resourceType", ""),
    });
  }
  if (currentTrigger) {
    appliedFilters.push({
      key: "trigger",
      label: `Trigger: ${currentTrigger}`,
      onRemove: () => updateFilter("trigger", ""),
    });
  }

  return (
    <Page>
      <TitleBar title="Sync Logs" />
      <BlockStack gap="500">
        <Card>
          <InlineStack gap="400" wrap>
            <Box minWidth="150px">
              <Select
                label="Status"
                labelInline
                options={[
                  { label: "All", value: "" },
                  { label: "Success", value: "SUCCESS" },
                  { label: "Failed", value: "FAILED" },
                  { label: "Partial", value: "PARTIAL" },
                  { label: "Skipped", value: "SKIPPED" },
                  { label: "Retrying", value: "RETRYING" },
                ]}
                value={currentStatus}
                onChange={(v) => updateFilter("status", v)}
              />
            </Box>
            <Box minWidth="150px">
              <Select
                label="Type"
                labelInline
                options={[
                  { label: "All", value: "" },
                  { label: "Product", value: "PRODUCT" },
                  { label: "Collection", value: "COLLECTION" },
                  { label: "Inventory", value: "INVENTORY" },
                  { label: "Metafield", value: "METAFIELD" },
                  { label: "Image", value: "IMAGE" },
                ]}
                value={currentResourceType}
                onChange={(v) => updateFilter("resourceType", v)}
              />
            </Box>
            <Box minWidth="150px">
              <Select
                label="Trigger"
                labelInline
                options={[
                  { label: "All", value: "" },
                  { label: "Webhook", value: "WEBHOOK" },
                  { label: "Scheduled", value: "SCHEDULED" },
                  { label: "Manual", value: "MANUAL" },
                  { label: "Bulk", value: "BULK_OPERATION" },
                  { label: "Retry", value: "RETRY" },
                ]}
                value={currentTrigger}
                onChange={(v) => updateFilter("trigger", v)}
              />
            </Box>
          </InlineStack>
        </Card>

        <Card padding="0">
          <IndexTable
            headings={[
              { title: "Time" },
              { title: "Action" },
              { title: "Type" },
              { title: "Status" },
              { title: "Trigger" },
              { title: "Rule" },
              { title: "Duration" },
              { title: "Details" },
            ]}
            itemCount={logs.length}
            selectable={false}
          >
            {logs.map((log: any, index: number) => (
              <IndexTable.Row id={log.id} key={log.id} position={index}>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm">
                    {new Date(log.createdAt).toLocaleString()}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge>{log.action}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>{log.resourceType}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={statusBadgeTone(log.status)}>
                    {log.status}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone="info">{log.trigger}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {log.ruleName || "-"}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {log.duration ? `${log.duration}ms` : "-"}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {log.errorDetail ? (
                    <Text as="span" variant="bodySm" tone="critical">
                      {log.errorDetail.substring(0, 80)}
                      {log.errorDetail.length > 80 ? "..." : ""}
                    </Text>
                  ) : log.message ? (
                    <Text as="span" variant="bodySm">
                      {log.message}
                    </Text>
                  ) : (
                    "-"
                  )}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        {pagination.totalPages > 1 && (
          <InlineStack align="center">
            <Pagination
              hasPrevious={pagination.page > 1}
              hasNext={pagination.page < pagination.totalPages}
              onPrevious={() => goToPage(pagination.page - 1)}
              onNext={() => goToPage(pagination.page + 1)}
              label={`Page ${pagination.page} of ${pagination.totalPages} (${pagination.totalCount} total)`}
            />
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}
