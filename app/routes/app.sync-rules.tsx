import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  TextField,
  Modal,
  Box,
  Select,
  Checkbox,
  Divider,
  IndexTable,
  Banner,
  Tag,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { triggerManualSync } from "../services/sync-engine.server";
import { setupScheduledSync, removeScheduledSync } from "../jobs/queue.server";

const DEFAULT_FORM = {
  name: "",
  sourceStoreId: "",
  destStoreId: "",
  syncMode: "REALTIME",
  scheduleInterval: "",
  priceRuleId: "",
  filterType: "ALL",
  filterTags: "",
  filterProductIds: [] as Array<{ id: string; title: string }>,
  filterCollectionIds: [] as Array<{ id: string; title: string }>,
  destProductStatus: "SAME_AS_SOURCE",
  syncProducts: true,
  syncVariants: true,
  syncCollections: true,
  syncInventory: true,
  syncMetafields: true,
  syncImages: true,
  syncSeo: true,
  syncTags: true,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Keep ConnectedStore tokens fresh from the active Shopify session
  if (session?.shop && session?.accessToken) {
    try {
      const { encrypt } = await import("../utils/encryption.server");
      await prisma.connectedStore.updateMany({
        where: { shopDomain: session.shop },
        data: { accessToken: encrypt(session.accessToken) },
      });
    } catch (e) {
      console.warn("[SyncRules] Token refresh failed:", (e as Error).message);
    }
  }

  const [syncRules, stores, priceRules] = await Promise.all([
    prisma.syncRule.findMany({
      include: {
        sourceStore: { select: { shopDomain: true, shopName: true } },
        destStore: { select: { shopDomain: true, shopName: true } },
        priceRule: { select: { name: true } },
        _count: { select: { syncLogs: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.connectedStore.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, shopDomain: true, shopName: true, isBaseStore: true },
      orderBy: { isBaseStore: "desc" },
    }),
    prisma.priceRule.findMany({
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return json({
    syncRules: syncRules.map((r) => ({
      ...r,
      lastRunAt: r.lastRunAt?.toISOString() || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    stores,
    priceRules,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Keep ConnectedStore tokens fresh from the active Shopify session
  if (session?.shop && session?.accessToken) {
    try {
      const { encrypt } = await import("../utils/encryption.server");
      await prisma.connectedStore.updateMany({
        where: { shopDomain: session.shop },
        data: { accessToken: encrypt(session.accessToken) },
      });
    } catch (e) {
      // Non-critical: token refresh failed, continue with action
      console.warn("[SyncRules] Token refresh failed:", (e as Error).message);
    }
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const parseRuleData = (fd: FormData) => ({
    name: fd.get("name") as string,
    sourceStoreId: fd.get("sourceStoreId") as string,
    destStoreId: fd.get("destStoreId") as string,
    syncMode: fd.get("syncMode") as any,
    scheduleInterval: (fd.get("scheduleInterval") as any) || null,
    priceRuleId: (fd.get("priceRuleId") as string) || null,
    filterType: (fd.get("filterType") as any) || "ALL",
    filterTags: (fd.get("filterTags") as string) || null,
    filterProductIds: (fd.get("filterProductIds") as string) || null,
    filterCollectionIds: (fd.get("filterCollectionIds") as string) || null,
    destProductStatus: (fd.get("destProductStatus") as any) || "SAME_AS_SOURCE",
    syncProducts: fd.get("syncProducts") === "true",
    syncVariants: fd.get("syncVariants") === "true",
    syncCollections: fd.get("syncCollections") === "true",
    syncInventory: fd.get("syncInventory") === "true",
    syncMetafields: fd.get("syncMetafields") === "true",
    syncImages: fd.get("syncImages") === "true",
    syncSeo: fd.get("syncSeo") === "true",
    syncTags: fd.get("syncTags") === "true",
  });

  switch (intent) {
    case "create": {
      const data = parseRuleData(formData);
      if (!data.name || !data.sourceStoreId || !data.destStoreId) {
        return json({ error: "Name, source store, and destination store are required" }, { status: 400 });
      }

      const newRule = await prisma.syncRule.create({ data });

      if (
        data.scheduleInterval &&
        (data.syncMode === "SCHEDULED" || data.syncMode === "REALTIME_AND_SCHEDULED")
      ) {
        await setupScheduledSync(newRule.id, data.scheduleInterval);
      }

      return json({ success: true });
    }

    case "update": {
      const ruleId = formData.get("ruleId") as string;
      const data = parseRuleData(formData);
      if (!data.name) {
        return json({ error: "Name is required" }, { status: 400 });
      }

      try {
        // Remove source/dest store IDs from update (can't change stores)
        const { sourceStoreId, destStoreId, ...updateData } = data;

        await prisma.syncRule.update({
          where: { id: ruleId },
          data: updateData,
        });

        // Update scheduled sync
        await removeScheduledSync(ruleId);
        if (
          updateData.scheduleInterval &&
          (updateData.syncMode === "SCHEDULED" || updateData.syncMode === "REALTIME_AND_SCHEDULED")
        ) {
          await setupScheduledSync(ruleId, updateData.scheduleInterval);
        }

        return json({ success: true });
      } catch (error) {
        console.error("[SyncRules] Update error:", error);
        return json({ error: (error as Error).message }, { status: 400 });
      }
    }

    case "toggle": {
      const ruleId = formData.get("ruleId") as string;
      const isActive = formData.get("isActive") === "true";
      await prisma.syncRule.update({
        where: { id: ruleId },
        data: { isActive },
      });
      return json({ success: true });
    }

    case "delete": {
      const ruleId = formData.get("ruleId") as string;
      await removeScheduledSync(ruleId);
      await prisma.syncRule.delete({ where: { id: ruleId } });
      return json({ success: true });
    }

    case "sync-now": {
      const ruleId = formData.get("ruleId") as string;
      try {
        const result = await triggerManualSync(ruleId);
        return json({ success: true, ...result });
      } catch (error) {
        return json({ error: (error as Error).message }, { status: 400 });
      }
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function SyncRulesPage() {
  const { syncRules, stores, priceRules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting" || fetcher.state === "submitting";

  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editRuleId, setEditRuleId] = useState<string | null>(null);
  const [formData, setFormData] = useState(DEFAULT_FORM);

  const baseStores = stores.filter((s: any) => s.isBaseStore);
  const destStores = stores.filter((s: any) => !s.isBaseStore);

  const openCreateModal = () => {
    setFormData(DEFAULT_FORM);
    setEditRuleId(null);
    setModalMode("create");
  };

  const openEditModal = (rule: any) => {
    let filterProductIds: Array<{ id: string; title: string }> = [];
    let filterCollectionIds: Array<{ id: string; title: string }> = [];
    try {
      if (rule.filterProductIds) filterProductIds = JSON.parse(rule.filterProductIds).map((id: string) => ({ id, title: id.replace("gid://shopify/Product/", "Product #") }));
    } catch {}
    try {
      if (rule.filterCollectionIds) filterCollectionIds = JSON.parse(rule.filterCollectionIds).map((id: string) => ({ id, title: id.replace("gid://shopify/Collection/", "Collection #") }));
    } catch {}

    setFormData({
      name: rule.name,
      sourceStoreId: rule.sourceStoreId,
      destStoreId: rule.destStoreId,
      syncMode: rule.syncMode,
      scheduleInterval: rule.scheduleInterval || "",
      priceRuleId: rule.priceRuleId || "",
      filterType: rule.filterType,
      filterTags: rule.filterTags || "",
      filterProductIds,
      filterCollectionIds,
      destProductStatus: rule.destProductStatus,
      syncProducts: rule.syncProducts,
      syncVariants: rule.syncVariants,
      syncCollections: rule.syncCollections,
      syncInventory: rule.syncInventory,
      syncMetafields: rule.syncMetafields,
      syncImages: rule.syncImages,
      syncSeo: rule.syncSeo,
      syncTags: rule.syncTags,
    });
    setEditRuleId(rule.id);
    setModalMode("edit");
  };

  const handleSubmitModal = () => {
    const data = new FormData();
    data.set("intent", modalMode === "edit" ? "update" : "create");
    if (editRuleId) data.set("ruleId", editRuleId);
    Object.entries(formData).forEach(([key, value]) => {
      if (key === "filterProductIds") {
        const ids = (value as Array<{ id: string }>).map((p) => p.id);
        data.set(key, ids.length > 0 ? JSON.stringify(ids) : "");
      } else if (key === "filterCollectionIds") {
        const ids = (value as Array<{ id: string }>).map((c) => c.id);
        data.set(key, ids.length > 0 ? JSON.stringify(ids) : "");
      } else {
        data.set(key, String(value));
      }
    });
    fetcher.submit(data, { method: "POST" });
    setModalMode(null);
  };

  const handleToggle = (ruleId: string, currentActive: boolean) => {
    submit(
      { intent: "toggle", ruleId, isActive: String(!currentActive) },
      { method: "POST" }
    );
  };

  const handleDelete = (ruleId: string) => {
    submit({ intent: "delete", ruleId }, { method: "POST" });
  };

  const handleSyncNow = (ruleId: string) => {
    fetcher.submit({ intent: "sync-now", ruleId }, { method: "POST" });
  };

  const openProductPicker = useCallback(async () => {
    try {
      const selected = await (window as any).shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
        selectionIds: formData.filterProductIds.map((p) => ({ id: p.id })),
      });
      if (selected) {
        setFormData((prev) => ({
          ...prev,
          filterProductIds: selected.map((p: any) => ({ id: p.id, title: p.title })),
        }));
      }
    } catch (e) {
      console.error("Product picker error:", e);
    }
  }, [formData.filterProductIds]);

  const openCollectionPicker = useCallback(async () => {
    try {
      const selected = await (window as any).shopify.resourcePicker({
        type: "collection",
        action: "select",
        multiple: true,
        selectionIds: formData.filterCollectionIds.map((c) => ({ id: c.id })),
      });
      if (selected) {
        setFormData((prev) => ({
          ...prev,
          filterCollectionIds: selected.map((c: any) => ({ id: c.id, title: c.title })),
        }));
      }
    } catch (e) {
      console.error("Collection picker error:", e);
    }
  }, [formData.filterCollectionIds]);

  const removeSelectedProduct = useCallback((idToRemove: string) => {
    setFormData((prev) => ({
      ...prev,
      filterProductIds: prev.filterProductIds.filter((p) => p.id !== idToRemove),
    }));
  }, []);

  const removeSelectedCollection = useCallback((idToRemove: string) => {
    setFormData((prev) => ({
      ...prev,
      filterCollectionIds: prev.filterCollectionIds.filter((c) => c.id !== idToRemove),
    }));
  }, []);

  const renderSyncToggles = () => (
    <InlineStack gap="400" wrap>
      <Checkbox
        label="Products"
        checked={formData.syncProducts}
        onChange={(v) => setFormData({ ...formData, syncProducts: v })}
      />
      <Checkbox
        label="Variants & Pricing"
        checked={formData.syncVariants}
        onChange={(v) => setFormData({ ...formData, syncVariants: v })}
      />
      <Checkbox
        label="Collections"
        checked={formData.syncCollections}
        onChange={(v) => setFormData({ ...formData, syncCollections: v })}
      />
      <Checkbox
        label="Inventory"
        checked={formData.syncInventory}
        onChange={(v) => setFormData({ ...formData, syncInventory: v })}
      />
      <Checkbox
        label="Metafields"
        checked={formData.syncMetafields}
        onChange={(v) => setFormData({ ...formData, syncMetafields: v })}
      />
      <Checkbox
        label="Images"
        checked={formData.syncImages}
        onChange={(v) => setFormData({ ...formData, syncImages: v })}
      />
      <Checkbox
        label="SEO"
        checked={formData.syncSeo}
        onChange={(v) => setFormData({ ...formData, syncSeo: v })}
      />
      <Checkbox
        label="Tags"
        checked={formData.syncTags}
        onChange={(v) => setFormData({ ...formData, syncTags: v })}
      />
    </InlineStack>
  );

  return (
    <Page>
      <TitleBar title="Sync Rules">
        <button variant="primary" onClick={openCreateModal}>
          Create Sync Rule
        </button>
      </TitleBar>

      <BlockStack gap="500">
        {fetcher.data?.error && (
          <Banner tone="critical" title="Error">
            <p>{fetcher.data.error}</p>
          </Banner>
        )}
        {fetcher.data?.success && fetcher.data?.queued !== undefined && (
          <Banner tone="success" title="Sync complete">
            <p>Synced {fetcher.data.queued} products. {fetcher.data.errors?.length > 0 ? `${fetcher.data.errors.length} errors occurred.` : ""}</p>
          </Banner>
        )}
        {syncRules.length === 0 ? (
          <Card>
            <BlockStack gap="300" inlineAlign="center">
              <Text as="p" variant="bodyMd" tone="subdued">
                No sync rules yet. Create your first rule to start syncing
                products between stores.
              </Text>
              <Button variant="primary" onClick={openCreateModal}>
                Create Sync Rule
              </Button>
            </BlockStack>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              headings={[
                { title: "Name" },
                { title: "Source" },
                { title: "Destination" },
                { title: "Mode" },
                { title: "Filter" },
                { title: "Syncs" },
                { title: "Status" },
                { title: "Actions" },
              ]}
              itemCount={syncRules.length}
              selectable={false}
            >
              {syncRules.map((rule: any, index: number) => (
                <IndexTable.Row id={rule.id} key={rule.id} position={index}>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {rule.name}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {rule.sourceStore.shopName || rule.sourceStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {rule.destStore.shopName || rule.destStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{rule.syncMode}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={rule.filterType === "ALL" ? "info" : "attention"}>
                      {rule.filterType}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="100" wrap>
                      {rule.syncProducts && <Badge tone="success">P</Badge>}
                      {rule.syncCollections && <Badge tone="success">C</Badge>}
                      {rule.syncInventory && <Badge tone="success">I</Badge>}
                      {rule.syncMetafields && <Badge tone="success">M</Badge>}
                      {rule.syncImages && <Badge tone="success">Img</Badge>}
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={rule.isActive ? "success" : "attention"}>
                      {rule.isActive ? "Active" : "Paused"}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      <Button
                        size="slim"
                        onClick={() => openEditModal(rule)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="slim"
                        onClick={() => handleSyncNow(rule.id)}
                        loading={isSubmitting}
                      >
                        Sync Now
                      </Button>
                      <Button
                        size="slim"
                        onClick={() => handleToggle(rule.id, rule.isActive)}
                      >
                        {rule.isActive ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => handleDelete(rule.id)}
                      >
                        Delete
                      </Button>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>

      {/* Create/Edit Modal */}
      <Modal
        open={modalMode !== null}
        onClose={() => setModalMode(null)}
        title={modalMode === "edit" ? "Edit Sync Rule" : "Create Sync Rule"}
        primaryAction={{
          content: modalMode === "edit" ? "Save Changes" : "Create Rule",
          onAction: handleSubmitModal,
          loading: isSubmitting,
          disabled: !formData.name || (!editRuleId && (!formData.sourceStoreId || !formData.destStoreId)),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setModalMode(null) },
        ]}
        size="large"
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Rule name"
              value={formData.name}
              onChange={(v) => setFormData({ ...formData, name: v })}
              placeholder="e.g., Sync all products to US store"
              autoComplete="off"
            />

            {/* Store selection - only for create */}
            {modalMode === "create" && (
              <InlineStack gap="400">
                <Box minWidth="200px">
                  <Select
                    label="Source store"
                    options={[
                      { label: "Select source...", value: "" },
                      ...baseStores.map((s: any) => ({
                        label: s.shopName || s.shopDomain,
                        value: s.id,
                      })),
                    ]}
                    value={formData.sourceStoreId}
                    onChange={(v) => setFormData({ ...formData, sourceStoreId: v })}
                  />
                </Box>
                <Box minWidth="200px">
                  <Select
                    label="Destination store"
                    options={[
                      { label: "Select destination...", value: "" },
                      ...destStores.map((s: any) => ({
                        label: s.shopName || s.shopDomain,
                        value: s.id,
                      })),
                    ]}
                    value={formData.destStoreId}
                    onChange={(v) => setFormData({ ...formData, destStoreId: v })}
                  />
                </Box>
              </InlineStack>
            )}

            {modalMode === "edit" && (
              <Banner tone="info">
                Source and destination stores cannot be changed after creation.
              </Banner>
            )}

            <Divider />
            <Text as="h3" variant="headingSm">What to sync</Text>
            {renderSyncToggles()}

            <Divider />
            <Text as="h3" variant="headingSm">Filters</Text>
            <InlineStack gap="400">
              <Box minWidth="200px">
                <Select
                  label="Filter type"
                  options={[
                    { label: "All products", value: "ALL" },
                    { label: "Selected collections", value: "SELECTED_COLLECTIONS" },
                    { label: "Selected products", value: "SELECTED_PRODUCTS" },
                    { label: "By tags", value: "BY_TAGS" },
                  ]}
                  value={formData.filterType}
                  onChange={(v) => setFormData({ ...formData, filterType: v })}
                />
              </Box>
              <Box minWidth="200px">
                <Select
                  label="Destination product status"
                  options={[
                    { label: "Same as source", value: "SAME_AS_SOURCE" },
                    { label: "Always Active", value: "ALWAYS_ACTIVE" },
                    { label: "Always Draft", value: "ALWAYS_DRAFT" },
                  ]}
                  value={formData.destProductStatus}
                  onChange={(v) => setFormData({ ...formData, destProductStatus: v })}
                />
              </Box>
            </InlineStack>

            {/* Tag filter input */}
            {formData.filterType === "BY_TAGS" && (
              <TextField
                label="Filter by tags"
                value={formData.filterTags}
                onChange={(v) => setFormData({ ...formData, filterTags: v })}
                placeholder="tag1, tag2, tag3"
                helpText="Comma-separated list of tags. Products matching any tag will be synced."
                autoComplete="off"
              />
            )}

            {formData.filterType === "SELECTED_COLLECTIONS" && (
              <BlockStack gap="300">
                <Button onClick={openCollectionPicker}>
                  {formData.filterCollectionIds.length > 0 ? "Change collections" : "Select collections"}
                </Button>
                {formData.filterCollectionIds.length > 0 && (
                  <InlineStack gap="200" wrap>
                    {formData.filterCollectionIds.map((c) => (
                      <Tag key={c.id} onRemove={() => removeSelectedCollection(c.id)}>
                        {c.title}
                      </Tag>
                    ))}
                  </InlineStack>
                )}
                {formData.filterCollectionIds.length === 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No collections selected. Click above to choose collections.
                  </Text>
                )}
              </BlockStack>
            )}

            {formData.filterType === "SELECTED_PRODUCTS" && (
              <BlockStack gap="300">
                <Button onClick={openProductPicker}>
                  {formData.filterProductIds.length > 0 ? "Change products" : "Select products"}
                </Button>
                {formData.filterProductIds.length > 0 && (
                  <InlineStack gap="200" wrap>
                    {formData.filterProductIds.map((p) => (
                      <Tag key={p.id} onRemove={() => removeSelectedProduct(p.id)}>
                        {p.title}
                      </Tag>
                    ))}
                  </InlineStack>
                )}
                {formData.filterProductIds.length === 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No products selected. Click above to choose products.
                  </Text>
                )}
              </BlockStack>
            )}

            <Divider />
            <Text as="h3" variant="headingSm">Schedule</Text>
            <InlineStack gap="400">
              <Box minWidth="200px">
                <Select
                  label="Sync mode"
                  options={[
                    { label: "Real-time (webhooks)", value: "REALTIME" },
                    { label: "Scheduled", value: "SCHEDULED" },
                    { label: "Real-time + Scheduled", value: "REALTIME_AND_SCHEDULED" },
                    { label: "Manual only", value: "MANUAL" },
                  ]}
                  value={formData.syncMode}
                  onChange={(v) => setFormData({ ...formData, syncMode: v })}
                />
              </Box>
              {(formData.syncMode === "SCHEDULED" ||
                formData.syncMode === "REALTIME_AND_SCHEDULED") && (
                <Box minWidth="200px">
                  <Select
                    label="Schedule interval"
                    options={[
                      { label: "Every 5 minutes", value: "EVERY_5_MIN" },
                      { label: "Every 15 minutes", value: "EVERY_15_MIN" },
                      { label: "Every 30 minutes", value: "EVERY_30_MIN" },
                      { label: "Hourly", value: "HOURLY" },
                      { label: "Every 6 hours", value: "EVERY_6_HOURS" },
                      { label: "Daily", value: "DAILY" },
                    ]}
                    value={formData.scheduleInterval}
                    onChange={(v) => setFormData({ ...formData, scheduleInterval: v })}
                  />
                </Box>
              )}
            </InlineStack>

            <Select
              label="Price rule (optional)"
              options={[
                { label: "No price transformation", value: "" },
                ...priceRules.map((r: any) => ({
                  label: `${r.name} (${r.type})`,
                  value: r.id,
                })),
              ]}
              value={formData.priceRuleId}
              onChange={(v) => setFormData({ ...formData, priceRuleId: v })}
              helpText="Apply a price transformation when syncing to destination"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <Page title="Sync Rules - Error">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Error {error.status}
            </Text>
            <Text as="p">{error.statusText || "An error occurred"}</Text>
            <Text as="p" tone="subdued">
              {typeof error.data === "string" ? error.data : JSON.stringify(error.data)}
            </Text>
            <Button url="/app/sync-rules">Reload page</Button>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Sync Rules - Error">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unknown error"}
          </Text>
          <Button url="/app/sync-rules">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
