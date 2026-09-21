import { useState } from "react";
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
        update: { direction, isActive: true, lastError: null },
        create: {
          ownerShop,
          sourceStoreId,
          destStoreId,
          direction,
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
  const { stores, rules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [sourceStoreId, setSourceStoreId] = useState(stores.find((store) => store.isBaseStore)?.id || "");
  const [destStoreId, setDestStoreId] = useState(stores.find((store) => !store.isBaseStore)?.id || "");
  const [direction, setDirection] = useState("TWO_WAY");

  const storeOptions = [
    { label: "Select store...", value: "" },
    ...stores.map((store) => ({
      label: store.shopName || store.shopDomain,
      value: store.id,
    })),
  ];

  const createRule = () => {
    submit(
      { intent: "create", sourceStoreId, destStoreId, direction },
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
              <Button variant="primary" onClick={createRule} loading={isSubmitting} disabled={!sourceStoreId || !destStoreId || sourceStoreId === destStoreId}>
                Save rule
              </Button>
            </InlineStack>
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
