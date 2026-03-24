import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const resourceType = url.searchParams.get("resourceType") || "";
  const status = url.searchParams.get("status") || "";
  const trigger = url.searchParams.get("trigger") || "";
  const syncRuleId = url.searchParams.get("syncRuleId") || "";

  const where: any = {};
  if (resourceType) where.resourceType = resourceType;
  if (status) where.status = status;
  if (trigger) where.trigger = trigger;
  if (syncRuleId) where.syncRuleId = syncRuleId;

  const [logs, total, syncRules] = await Promise.all([
    prisma.syncLog.findMany({
      where,
      include: {
        syncRule: { select: { name: true } },
        store: { select: { shopDomain: true, shopName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.syncLog.count({ where }),
    prisma.syncRule.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return json({
    logs: logs.map((l) => ({
      id: l.id,
      action: l.action,
      resourceType: l.resourceType,
      sourceGid: l.sourceGid,
      destGid: l.destGid,
      status: l.status,
      trigger: l.trigger,
      message: l.message,
      errorDetail: l.errorDetail,
      duration: l.duration,
      ruleName: l.syncRule?.name ?? null,
      storeName: l.store?.shopName || l.store?.shopDomain || null,
      createdAt: l.createdAt.toISOString(),
    })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    syncRules,
    filters: { resourceType, status, trigger, syncRuleId },
  });
};

export default function ActivityPage() {
  const { logs, total, page, totalPages, syncRules, filters } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    setSearchParams(params);
  };

  const goToPage = (newPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(newPage));
    setSearchParams(params);
  };

  const getStatusTone = (status: string) => {
    switch (status) {
      case "SUCCESS": return "success" as const;
      case "FAILED": return "critical" as const;
      case "RETRYING": return "warning" as const;
      case "SKIPPED": return "info" as const;
      default: return "attention" as const;
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case "CREATE": return "+";
      case "UPDATE": return "~";
      case "DELETE": return "x";
      case "SKIP": return "-";
      default: return "?";
    }
  };

  return (
    <Page>
      <TitleBar title="Activity Timeline" />

      <BlockStack gap="500">
        {/* Filters */}
        <Card>
          <InlineStack gap="400" wrap>
            <Box minWidth="180px">
              <Select
                label="Resource type"
                options={[
                  { label: "All types", value: "" },
                  { label: "Product", value: "PRODUCT" },
                  { label: "Collection", value: "COLLECTION" },
                  { label: "Inventory", value: "INVENTORY" },
                  { label: "Metafield", value: "METAFIELD" },
                  { label: "Image", value: "IMAGE" },
                ]}
                value={filters.resourceType}
                onChange={(v) => updateFilter("resourceType", v)}
              />
            </Box>
            <Box minWidth="150px">
              <Select
                label="Status"
                options={[
                  { label: "All statuses", value: "" },
                  { label: "Success", value: "SUCCESS" },
                  { label: "Failed", value: "FAILED" },
                  { label: "Retrying", value: "RETRYING" },
                  { label: "Skipped", value: "SKIPPED" },
                ]}
                value={filters.status}
                onChange={(v) => updateFilter("status", v)}
              />
            </Box>
            <Box minWidth="150px">
              <Select
                label="Trigger"
                options={[
                  { label: "All triggers", value: "" },
                  { label: "Webhook", value: "WEBHOOK" },
                  { label: "Scheduled", value: "SCHEDULED" },
                  { label: "Manual", value: "MANUAL" },
                  { label: "Bulk Operation", value: "BULK_OPERATION" },
                  { label: "Retry", value: "RETRY" },
                ]}
                value={filters.trigger}
                onChange={(v) => updateFilter("trigger", v)}
              />
            </Box>
            <Box minWidth="200px">
              <Select
                label="Sync rule"
                options={[
                  { label: "All rules", value: "" },
                  ...syncRules.map((r: any) => ({ label: r.name, value: r.id })),
                ]}
                value={filters.syncRuleId}
                onChange={(v) => updateFilter("syncRuleId", v)}
              />
            </Box>
          </InlineStack>
        </Card>

        {/* Results count */}
        <Text as="p" variant="bodySm" tone="subdued">
          Showing {logs.length} of {total} entries (page {page} of {totalPages})
        </Text>

        {/* Activity Table */}
        <Card padding="0">
          <IndexTable
            headings={[
              { title: "Time" },
              { title: "Action" },
              { title: "Type" },
              { title: "Source" },
              { title: "Rule" },
              { title: "Store" },
              { title: "Status" },
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
                  <Badge
                    tone={log.action === "CREATE" ? "success" : log.action === "DELETE" ? "critical" : "info"}
                  >
                    {`${getActionIcon(log.action)} ${log.action}`}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge>{log.resourceType}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm">
                    {log.sourceGid
                      ? log.sourceGid.replace(/gid:\/\/shopify\/\w+\//, "#")
                      : "—"}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm">
                    {log.ruleName || "—"}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm">
                    {log.storeName || "—"}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={getStatusTone(log.status)}>{log.status}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {log.duration ? `${log.duration}ms` : "—"}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm" tone={log.errorDetail ? "critical" : "subdued"}>
                    {log.errorDetail
                      ? log.errorDetail.substring(0, 60) + (log.errorDetail.length > 60 ? "..." : "")
                      : log.message || "—"}
                  </Text>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <InlineStack align="center">
            <Pagination
              hasPrevious={page > 1}
              hasNext={page < totalPages}
              onPrevious={() => goToPage(page - 1)}
              onNext={() => goToPage(page + 1)}
            />
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}
