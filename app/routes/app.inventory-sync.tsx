import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Select,
  Button,
  Badge,
  Banner,
  IndexTable,
  TextField,
  Tag,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAccountShop } from "../services/store-management.server";
import { registerWebhooksForStore } from "../services/webhook-registration.server";

const DIRECTION_OPTIONS = [
  { label: "Two-way instant sync", value: "TWO_WAY" },
  { label: "One-way: source to destination", value: "ONE_WAY" },
];

const FILTER_OPTIONS = [
  { label: "All mapped products", value: "ALL" },
  { label: "Selected products", value: "SELECTED_PRODUCTS" },
  { label: "Selected collections", value: "SELECTED_COLLECTIONS" },
  { label: "By tags", value: "BY_TAGS" },
];

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const ownerShop = await getAccountShop(session.shop);

  const [stores, rules] = await Promise.all([
    prisma.connectedStore.findMany({
      where: { ownerShop, status: "ACTIVE" },
      select: { id: true, shopDomain: true, shopName: true, isBaseStore: true },
      orderBy: [{ isBaseStore: "desc" }, { shopName: "asc" }],
    }),
    prisma.inventorySyncRule.findMany({
      where: { ownerShop },
      include: {
        sourceStore: { select: { shopDomain: true, shopName: true } },
        destStore: { select: { shopDomain: true, shopName: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return json({
    currentShop: session.shop,
    stores,
    rules: rules.map((rule) => ({
      ...rule,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      lastRunAt: rule.lastRunAt?.toISOString() || null,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const ownerShop = await getAccountShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "create": {
      const sourceStoreId = formData.get("sourceStoreId") as string;
      const destStoreId = formData.get("destStoreId") as string;
      const direction = formData.get("direction") === "ONE_WAY" ? "ONE_WAY" : "TWO_WAY";
      const filterType = (formData.get("filterType") as string) || "ALL";
      const filterProductIds = (formData.get("filterProductIds") as string) || null;
      const filterCollectionIds = (formData.get("filterCollectionIds") as string) || null;
      const filterTags = (formData.get("filterTags") as string) || null;

      if (!sourceStoreId || !destStoreId || sourceStoreId === destStoreId) {
        return json({ error: "Choose two different stores." }, { status: 400 });
      }

      const storeCount = await prisma.connectedStore.count({
        where: { id: { in: [sourceStoreId, destStoreId] }, ownerShop, status: "ACTIVE" },
      });
      if (storeCount !== 2) {
        return json({ error: "Both stores must belong to this account." }, { status: 400 });
      }

      await prisma.inventorySyncRule.upsert({
        where: {
          sourceStoreId_destStoreId: {
            sourceStoreId,
            destStoreId,
          },
        },
        update: {
          direction,
          filterType: filterType as any,
          filterProductIds,
          filterCollectionIds,
          filterTags,
          isActive: true,
          lastError: null,
        },
        create: {
          ownerShop,
          sourceStoreId,
          destStoreId,
          direction,
          filterType: filterType as any,
          filterProductIds,
          filterCollectionIds,
          filterTags,
        },
      });

      const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";
      if (appUrl) {
        await Promise.allSettled([
          registerWebhooksForStore(sourceStoreId, appUrl, true),
          registerWebhooksForStore(destStoreId, appUrl, true),
        ]);
      }

      return json({ success: true });
    }

    case "toggle": {
      const ruleId = formData.get("ruleId") as string;
      const isActive = formData.get("isActive") === "true";
      const result = await prisma.inventorySyncRule.updateMany({
        where: { id: ruleId, ownerShop },
        data: { isActive },
      });
      if (result.count === 0) {
        return json({ error: "Inventory sync rule not found." }, { status: 404 });
      }
      return json({ success: true });
    }

    case "delete": {
      const ruleId = formData.get("ruleId") as string;
      await prisma.inventorySyncRule.deleteMany({ where: { id: ruleId, ownerShop } });
      return json({ success: true });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function InventorySyncPage() {
  const { currentShop, stores, rules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [sourceStoreId, setSourceStoreId] = useState(stores.find((store) => store.isBaseStore)?.id || "");
  const [destStoreId, setDestStoreId] = useState(stores.find((store) => !store.isBaseStore)?.id || "");
  const [direction, setDirection] = useState("TWO_WAY");
  const [filterType, setFilterType] = useState("ALL");
  const [filterTags, setFilterTags] = useState("");
  const [filterProductIds, setFilterProductIds] = useState<Array<{ id: string; title: string }>>([]);
  const [filterCollectionIds, setFilterCollectionIds] = useState<Array<{ id: string; title: string }>>([]);
  const sourceStore = stores.find((store) => store.id === sourceStoreId);
  const canPickFromCurrentShop = !!sourceStore && sourceStore.shopDomain === currentShop;

  const storeOptions = [
    { label: "Select store...", value: "" },
    ...stores.map((store) => ({
      label: store.shopName || store.shopDomain,
      value: store.id,
    })),
  ];

  const createRule = () => {
    submit(
      {
        intent: "create",
        sourceStoreId,
        destStoreId,
        direction,
        filterType,
        filterProductIds: JSON.stringify(filterProductIds.map((product) => product.id)),
        filterCollectionIds: JSON.stringify(filterCollectionIds.map((collection) => collection.id)),
        filterTags,
      },
      { method: "POST" }
    );
  };

  const toggleRule = (ruleId: string, nextActive: boolean) => {
    submit(
      { intent: "toggle", ruleId, isActive: String(nextActive) },
      { method: "POST" }
    );
  };

  const deleteRule = (ruleId: string) => {
    submit({ intent: "delete", ruleId }, { method: "POST" });
  };

  const openProductPicker = useCallback(async () => {
    try {
      const selected = await (window as any).shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
        selectionIds: filterProductIds.map((product) => ({ id: product.id })),
      });
      if (selected) {
        setFilterProductIds(selected.map((product: any) => ({ id: product.id, title: product.title })));
      }
    } catch (error) {
      console.error("Inventory product picker error:", error);
    }
  }, [filterProductIds]);

  const openCollectionPicker = useCallback(async () => {
    try {
      const selected = await (window as any).shopify.resourcePicker({
        type: "collection",
        action: "select",
        multiple: true,
        selectionIds: filterCollectionIds.map((collection) => ({ id: collection.id })),
      });
      if (selected) {
        setFilterCollectionIds(selected.map((collection: any) => ({ id: collection.id, title: collection.title })));
      }
    } catch (error) {
      console.error("Inventory collection picker error:", error);
    }
  }, [filterCollectionIds]);

  const filterSummary = (rule: typeof rules[number]) => {
    if (rule.filterType === "SELECTED_PRODUCTS") {
      const count = safeJsonArray(rule.filterProductIds).length;
      return `${count} selected product${count === 1 ? "" : "s"}`;
    }
    if (rule.filterType === "SELECTED_COLLECTIONS") {
      const count = safeJsonArray(rule.filterCollectionIds).length;
      return `${count} selected collection${count === 1 ? "" : "s"}`;
    }
    if (rule.filterType === "BY_TAGS") {
      return rule.filterTags || "No tags";
    }
    return "All mapped products";
  };

  return (
    <Page>
      <TitleBar title="Inventory Sync" />
      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Inventory sync is webhook-driven and usually updates instantly after Shopify sends an inventory event. A 1-minute fallback checks active rules for missed webhook delivery.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Create inventory-only sync</Text>
            <InlineStack gap="400" wrap>
              <Select label="Source store" options={storeOptions} value={sourceStoreId} onChange={setSourceStoreId} />
              <Select label="Destination store" options={storeOptions} value={destStoreId} onChange={setDestStoreId} />
              <Select label="Direction" options={DIRECTION_OPTIONS} value={direction} onChange={setDirection} />
              <Box minWidth="220px">
                <Select label="Products to sync" options={FILTER_OPTIONS} value={filterType} onChange={setFilterType} />
              </Box>
              <Button variant="primary" onClick={createRule} loading={isSubmitting} disabled={!sourceStoreId || !destStoreId || sourceStoreId === destStoreId}>
                Save rule
              </Button>
            </InlineStack>

            {filterType === "BY_TAGS" && (
              <TextField
                label="Tags"
                value={filterTags}
                onChange={setFilterTags}
                placeholder="tag1, tag2"
                autoComplete="off"
                helpText="Inventory sync applies to mapped source products matching any tag."
              />
            )}

            {filterType === "SELECTED_PRODUCTS" && (
              <BlockStack gap="300">
                {!canPickFromCurrentShop && (
                  <Banner tone="warning">
                    <p>Open the app from the selected source store admin to pick source products.</p>
                  </Banner>
                )}
                <Button onClick={openProductPicker} disabled={!canPickFromCurrentShop || !sourceStoreId}>
                  {filterProductIds.length > 0 ? "Change products" : "Select products"}
                </Button>
                <InlineStack gap="200" wrap>
                  {filterProductIds.map((product) => (
                    <Tag
                      key={product.id}
                      onRemove={() =>
                        setFilterProductIds((selected) => selected.filter((item) => item.id !== product.id))
                      }
                    >
                      {product.title}
                    </Tag>
                  ))}
                </InlineStack>
              </BlockStack>
            )}

            {filterType === "SELECTED_COLLECTIONS" && (
              <BlockStack gap="300">
                {!canPickFromCurrentShop && (
                  <Banner tone="warning">
                    <p>Open the app from the selected source store admin to pick source collections.</p>
                  </Banner>
                )}
                <Button onClick={openCollectionPicker} disabled={!canPickFromCurrentShop || !sourceStoreId}>
                  {filterCollectionIds.length > 0 ? "Change collections" : "Select collections"}
                </Button>
                <InlineStack gap="200" wrap>
                  {filterCollectionIds.map((collection) => (
                    <Tag
                      key={collection.id}
                      onRemove={() =>
                        setFilterCollectionIds((selected) => selected.filter((item) => item.id !== collection.id))
                      }
                    >
                      {collection.title}
                    </Tag>
                  ))}
                </InlineStack>
              </BlockStack>
            )}

            <Text as="p" variant="bodySm" tone="subdued">
              Only mapped products/variants are synced. Product details, price, images, SEO, tags, and collections are not changed from this page.
            </Text>
          </BlockStack>
        </Card>

        <Card padding="0">
          <IndexTable
            headings={[
              { title: "Source" },
              { title: "Destination" },
              { title: "Direction" },
              { title: "Products" },
              { title: "Status" },
              { title: "Last synced" },
              { title: "Last error" },
              { title: "Actions" },
            ]}
            itemCount={rules.length}
            selectable={false}
          >
            {rules.map((rule, index) => (
              <IndexTable.Row id={rule.id} key={rule.id} position={index}>
                <IndexTable.Cell>{rule.sourceStore.shopName || rule.sourceStore.shopDomain}</IndexTable.Cell>
                <IndexTable.Cell>{rule.destStore.shopName || rule.destStore.shopDomain}</IndexTable.Cell>
                <IndexTable.Cell>{rule.direction === "TWO_WAY" ? "Two-way" : "One-way"}</IndexTable.Cell>
                <IndexTable.Cell>{filterSummary(rule)}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={rule.isActive ? "success" : "attention"}>
                    {rule.isActive ? "Active" : "Paused"}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>{rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : "Never"}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" tone={rule.lastError ? "critical" : "subdued"}>
                    {rule.lastError || "None"}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack gap="200">
                    <Button size="slim" onClick={() => toggleRule(rule.id, !rule.isActive)}>
                      {rule.isActive ? "Pause" : "Resume"}
                    </Button>
                    <Button size="slim" tone="critical" onClick={() => deleteRule(rule.id)}>
                      Delete
                    </Button>
                  </InlineStack>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}
