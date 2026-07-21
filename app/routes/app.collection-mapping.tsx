import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher, useRouteError } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  TextField,
  Select,
  Checkbox,
  Autocomplete,
  IndexTable,
  Banner,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { withDbRetry } from "../utils/db-retry.server";
import { getAccountShop } from "../services/store-management.server";
import { triggerManualCollectionSync } from "../services/collection-sync.server";

const MISSING_PRODUCT_OPTIONS = [
  { label: "Skip it", value: "SKIP" },
  { label: "Create it as a new product", value: "CREATE" },
  { label: "Link it if it already exists on the destination (by handle), otherwise skip", value: "LINK_EXISTING" },
];

const TRIGGER_MODE_OPTIONS = [
  { label: "Live (real-time)", value: "REALTIME" },
  { label: "Manual only", value: "MANUAL" },
];

const DEST_PRODUCT_STATUS_OPTIONS = [
  { label: "Same as source", value: "SAME_AS_SOURCE" },
  { label: "Always Active", value: "ALWAYS_ACTIVE" },
  { label: "Always Draft", value: "ALWAYS_DRAFT" },
];

interface DestSelection {
  checked: boolean;
  destMode: "new" | "existing";
  destCollection: { id: string; title: string } | null;
  createPriceRuleId: string; // "" = no price adjustment
  createSyncVariants: boolean;
  createSyncImages: boolean;
  createSyncMetafields: boolean;
  createSyncSeo: boolean;
  createSyncTags: boolean;
  createSyncInventory: boolean;
  createDestProductStatus: string;
}

const DEFAULT_DEST_SELECTION: DestSelection = {
  checked: false,
  destMode: "new",
  destCollection: null,
  createPriceRuleId: "",
  createSyncVariants: true,
  createSyncImages: true,
  createSyncMetafields: true,
  createSyncSeo: true,
  createSyncTags: true,
  createSyncInventory: true,
  createDestProductStatus: "SAME_AS_SOURCE",
};

/**
 * One destination store's connect options: create-new-or-link-existing
 * collection, and — only while the shared "missing product" choice is
 * "Create" — its own price rule and what-to-sync settings, so two
 * destinations can use two different price rules. Owns its own
 * collection-search fetcher so multiple rows can search independently.
 */
function DestinationConnectRow({
  store,
  selection,
  priceRules,
  showCreateSettings,
  onChange,
}: {
  store: { id: string; label: string };
  selection: DestSelection;
  priceRules: Array<{ id: string; name: string }>;
  showCreateSettings: boolean;
  onChange: (patch: Partial<DestSelection>) => void;
}) {
  const collectionsFetcher = useFetcher<{ collections: Array<{ id: string; title: string; handle: string }> }>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (selection.checked && selection.destMode === "existing") {
      collectionsFetcher.load(`/api/store-collections/${store.id}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.checked, selection.destMode, store.id]);

  const options = useMemo(() => {
    const all = collectionsFetcher.data?.collections || [];
    const filtered = query ? all.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())) : all;
    return filtered.slice(0, 50).map((c) => ({ value: c.id, label: c.title }));
  }, [collectionsFetcher.data, query]);

  return (
    <Card padding="300">
      <BlockStack gap="200">
        <Checkbox
          label={store.label}
          checked={selection.checked}
          onChange={(checked) => onChange({ checked })}
        />
        {selection.checked && (
          <BlockStack gap="200">
            <Select
              label="Destination collection"
              options={[
                { label: "Create a new collection", value: "new" },
                { label: "Link to an existing collection", value: "existing" },
              ]}
              value={selection.destMode}
              onChange={(v) => onChange({ destMode: v as "new" | "existing", destCollection: null })}
            />
            {selection.destMode === "existing" && (
              <Autocomplete
                options={options}
                selected={selection.destCollection ? [selection.destCollection.id] : []}
                onSelect={(sel) => {
                  const id = sel[0];
                  const match = collectionsFetcher.data?.collections.find((c) => c.id === id);
                  if (match) onChange({ destCollection: { id: match.id, title: match.title } });
                }}
                loading={collectionsFetcher.state === "loading"}
                textField={
                  <Autocomplete.TextField
                    label="Existing destination collection"
                    value={selection.destCollection ? selection.destCollection.title : query}
                    onChange={(v) => {
                      setQuery(v);
                      if (selection.destCollection) onChange({ destCollection: null });
                    }}
                    placeholder="Search collections"
                    autoComplete="off"
                  />
                }
              />
            )}

            {showCreateSettings && (
              <BlockStack gap="200">
                <Select
                  label="Price rule for new products"
                  options={[
                    { label: "No price adjustment", value: "" },
                    ...priceRules.map((r) => ({ label: r.name, value: r.id })),
                  ]}
                  value={selection.createPriceRuleId}
                  onChange={(v) => onChange({ createPriceRuleId: v })}
                />
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    What to sync when creating the product
                  </Text>
                  <InlineStack gap="400" wrap>
                    <Checkbox
                      label="Variants & Pricing"
                      checked={selection.createSyncVariants}
                      onChange={(v) => onChange({ createSyncVariants: v })}
                    />
                    <Checkbox
                      label="Images"
                      checked={selection.createSyncImages}
                      onChange={(v) => onChange({ createSyncImages: v })}
                    />
                    <Checkbox
                      label="Metafields"
                      checked={selection.createSyncMetafields}
                      onChange={(v) => onChange({ createSyncMetafields: v })}
                    />
                    <Checkbox
                      label="SEO"
                      checked={selection.createSyncSeo}
                      onChange={(v) => onChange({ createSyncSeo: v })}
                    />
                    <Checkbox
                      label="Tags"
                      checked={selection.createSyncTags}
                      onChange={(v) => onChange({ createSyncTags: v })}
                    />
                    <Checkbox
                      label="Inventory"
                      checked={selection.createSyncInventory}
                      onChange={(v) => onChange({ createSyncInventory: v })}
                    />
                  </InlineStack>
                </BlockStack>
                <Select
                  label="Destination product status"
                  options={DEST_PRODUCT_STATUS_OPTIONS}
                  value={selection.createDestProductStatus}
                  onChange={(v) => onChange({ createDestProductStatus: v })}
                />
              </BlockStack>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const ownerShop = await withDbRetry(() => getAccountShop(session.shop));
    const [mappings, destStores, priceRules] = await withDbRetry(() =>
      Promise.all([
        prisma.collectionMapping.findMany({
          where: { sourceStore: { ownerShop } },
          include: {
            sourceStore: { select: { shopDomain: true, shopName: true } },
            destStore: { select: { shopDomain: true, shopName: true } },
            createPriceRule: { select: { name: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 100,
        }),
        prisma.connectedStore.findMany({
          where: { ownerShop, status: "ACTIVE", isBaseStore: false },
          select: { id: true, shopDomain: true, shopName: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.priceRule.findMany({
          where: { ownerShop },
          select: { id: true, name: true },
          orderBy: { createdAt: "desc" },
        }),
      ])
    );

    return json({
      mappings: mappings.map((m) => ({
        ...m,
        lastSyncedAt: m.lastSyncedAt?.toISOString(),
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      destStores,
      priceRules,
      loadError: null as string | null,
    });
  } catch (e) {
    console.error("[CollectionMapping] Loader DB error:", (e as Error).message);
    return json({
      mappings: [],
      destStores: [],
      priceRules: [],
      loadError:
        "Couldn't load collection mappings right now (temporary connection issue). Please reload.",
    });
  }
};

function parseMissingProductAction(raw: unknown): "SKIP" | "CREATE" | "LINK_EXISTING" {
  return raw === "CREATE" ? "CREATE" : raw === "LINK_EXISTING" ? "LINK_EXISTING" : "SKIP";
}

function parseDestProductStatus(raw: unknown): "SAME_AS_SOURCE" | "ALWAYS_ACTIVE" | "ALWAYS_DRAFT" {
  return raw === "ALWAYS_ACTIVE" ? "ALWAYS_ACTIVE" : raw === "ALWAYS_DRAFT" ? "ALWAYS_DRAFT" : "SAME_AS_SOURCE";
}

function parseTriggerMode(raw: unknown): "REALTIME" | "MANUAL" {
  return raw === "MANUAL" ? "MANUAL" : "REALTIME";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "create-mapping": {
      const sourceCollectionGid = formData.get("sourceCollectionGid") as string;
      const sourceHandle = (formData.get("sourceHandle") as string) || "";
      const missingProductAction = parseMissingProductAction(formData.get("missingProductAction"));
      const triggerMode = parseTriggerMode(formData.get("triggerMode"));

      interface DestinationInput {
        destStoreId: string;
        destCollectionGid: string | null;
        createPriceRuleId: string | null;
        createSyncVariants: boolean;
        createSyncImages: boolean;
        createSyncMetafields: boolean;
        createSyncSeo: boolean;
        createSyncTags: boolean;
        createSyncInventory: boolean;
        createDestProductStatus: string;
      }

      let destinations: DestinationInput[] = [];
      try {
        destinations = JSON.parse((formData.get("destinationsJson") as string) || "[]");
      } catch {
        return json({ error: "Invalid destination selection" }, { status: 400 });
      }
      destinations = destinations.filter((d) => d?.destStoreId);

      if (!destinations.length || !sourceCollectionGid) {
        return json({ error: "Choose at least one destination and a source collection" }, { status: 400 });
      }

      const ownerShop = await getAccountShop(session.shop);
      const sourceStore = await prisma.connectedStore.findUnique({
        where: { shopDomain: session.shop },
        select: { id: true },
      });
      if (!sourceStore) {
        return json({ error: "Source store not found" }, { status: 404 });
      }

      const validDestStores = await prisma.connectedStore.findMany({
        where: { id: { in: destinations.map((d) => d.destStoreId) }, ownerShop },
        select: { id: true },
      });
      const validDestIds = new Set(validDestStores.map((s) => s.id));

      for (const dest of destinations) {
        if (!validDestIds.has(dest.destStoreId)) continue;

        const destCollectionGid = dest.destCollectionGid || null;
        const createPriceRuleId = dest.createPriceRuleId || null;
        const createDestProductStatus = parseDestProductStatus(dest.createDestProductStatus);
        const shared = {
          missingProductAction,
          triggerMode,
          createPriceRuleId,
          createSyncVariants: !!dest.createSyncVariants,
          createSyncImages: !!dest.createSyncImages,
          createSyncMetafields: !!dest.createSyncMetafields,
          createSyncSeo: !!dest.createSyncSeo,
          createSyncTags: !!dest.createSyncTags,
          createSyncInventory: !!dest.createSyncInventory,
          createDestProductStatus,
        };

        await prisma.collectionMapping.upsert({
          where: {
            sourceStoreId_destStoreId_sourceCollectionGid: {
              sourceStoreId: sourceStore.id,
              destStoreId: dest.destStoreId,
              sourceCollectionGid,
            },
          },
          update: {
            destCollectionGid,
            ...shared,
          },
          create: {
            sourceStoreId: sourceStore.id,
            destStoreId: dest.destStoreId,
            sourceCollectionGid,
            sourceHandle,
            destCollectionGid,
            status: "PENDING",
            ...shared,
          },
        });
      }

      return json({ success: true });
    }

    case "update-title": {
      const mappingId = formData.get("mappingId") as string;
      const destTitle = formData.get("destTitle") as string;
      await prisma.collectionMapping.update({
        where: { id: mappingId },
        data: { destTitle: destTitle || null },
      });
      return json({ success: true });
    }

    case "update-missing-product-action": {
      const mappingId = formData.get("mappingId") as string;
      const missingProductAction = parseMissingProductAction(formData.get("missingProductAction"));
      await prisma.collectionMapping.update({
        where: { id: mappingId },
        data: { missingProductAction },
      });
      return json({ success: true });
    }

    case "update-trigger-mode": {
      const mappingId = formData.get("mappingId") as string;
      const triggerMode = parseTriggerMode(formData.get("triggerMode"));
      await prisma.collectionMapping.update({
        where: { id: mappingId },
        data: { triggerMode },
      });
      return json({ success: true });
    }

    case "sync-now": {
      const mappingId = formData.get("mappingId") as string;
      // Fire-and-forget: a full add/remove/reorder pass can take longer than
      // this request should wait. Results land in Sync Logs.
      triggerManualCollectionSync(mappingId).catch((err) =>
        console.error(`[CollectionMapping] Manual sync failed for ${mappingId}:`, (err as Error).message)
      );
      return json({ success: true, started: true });
    }

    case "delete": {
      const mappingId = formData.get("mappingId") as string;
      await prisma.collectionMapping.delete({ where: { id: mappingId } });
      return json({ success: true });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function CollectionMappingPage() {
  const { mappings, destStores, priceRules, loadError } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // ----- Create mapping form state -----
  const [destSelections, setDestSelections] = useState<Record<string, DestSelection>>(() => {
    const init: Record<string, DestSelection> = {};
    for (const store of destStores) {
      init[store.id] = { ...DEFAULT_DEST_SELECTION };
    }
    return init;
  });

  const updateDestSelection = (storeId: string, patch: Partial<DestSelection>) => {
    setDestSelections((prev) => ({
      ...prev,
      [storeId]: { ...prev[storeId], ...patch },
    }));
  };

  const [sourceCollection, setSourceCollection] = useState<{ id: string; title: string; handle: string } | null>(null);
  const [missingProductAction, setMissingProductAction] = useState("SKIP");
  const [triggerMode, setTriggerMode] = useState("REALTIME");

  const chosenEntries = Object.entries(destSelections).filter(([, s]) => s.checked);
  const hasIncompleteExisting = chosenEntries.some(
    ([, s]) => s.destMode === "existing" && !s.destCollection
  );

  const openSourceCollectionPicker = useCallback(async () => {
    try {
      const selected = await (window as any).shopify.resourcePicker({
        type: "collection",
        action: "select",
        multiple: false,
      });
      if (selected?.length) {
        setSourceCollection({
          id: selected[0].id,
          title: selected[0].title,
          handle: selected[0].handle,
        });
      }
    } catch (e) {
      console.error("Collection picker error:", e);
    }
  }, []);

  const handleCreateMapping = () => {
    if (!chosenEntries.length || !sourceCollection || hasIncompleteExisting) return;
    const fd = new FormData();
    fd.set("intent", "create-mapping");
    fd.set(
      "destinationsJson",
      JSON.stringify(
        chosenEntries.map(([storeId, s]) => ({
          destStoreId: storeId,
          destCollectionGid: s.destMode === "existing" && s.destCollection ? s.destCollection.id : null,
          createPriceRuleId: s.createPriceRuleId || null,
          createSyncVariants: s.createSyncVariants,
          createSyncImages: s.createSyncImages,
          createSyncMetafields: s.createSyncMetafields,
          createSyncSeo: s.createSyncSeo,
          createSyncTags: s.createSyncTags,
          createSyncInventory: s.createSyncInventory,
          createDestProductStatus: s.createDestProductStatus,
        }))
      )
    );
    fd.set("sourceCollectionGid", sourceCollection.id);
    fd.set("sourceHandle", sourceCollection.handle);
    fd.set("missingProductAction", missingProductAction);
    fd.set("triggerMode", triggerMode);
    submit(fd, { method: "POST" });

    setSourceCollection(null);
    setMissingProductAction("SKIP");
    setTriggerMode("REALTIME");
    setDestSelections((prev) => {
      const reset: Record<string, DestSelection> = {};
      for (const storeId of Object.keys(prev)) {
        reset[storeId] = { ...DEFAULT_DEST_SELECTION };
      }
      return reset;
    });
  };

  const handleSaveTitle = (mappingId: string) => {
    submit(
      { intent: "update-title", mappingId, destTitle: editTitle },
      { method: "POST" }
    );
    setEditingId(null);
  };

  const handleDelete = (mappingId: string) => {
    submit({ intent: "delete", mappingId }, { method: "POST" });
  };

  const handleSyncNow = (mappingId: string) => {
    submit({ intent: "sync-now", mappingId }, { method: "POST" });
  };

  const handleMissingProductActionChange = (mappingId: string, value: string) => {
    submit(
      { intent: "update-missing-product-action", mappingId, missingProductAction: value },
      { method: "POST" }
    );
  };

  const handleTriggerModeChange = (mappingId: string, value: string) => {
    submit(
      { intent: "update-trigger-mode", mappingId, triggerMode: value },
      { method: "POST" }
    );
  };

  return (
    <Page>
      <TitleBar title="Collection Mapping" />

      <BlockStack gap="500">
        {loadError && (
          <Banner tone="warning" title="Temporary issue">
            <p>{loadError}</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>
            Nothing syncs unless you connect it here. Pick a source collection and one or
            more destination stores below — only those specific collections will ever be
            created or updated on the destination store(s).
          </p>
        </Banner>

        {destStores.length === 0 ? (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                No connected destination stores yet
              </Text>
              <Text as="p" tone="subdued">
                Connect a destination store first, then come back here to connect specific
                collections.
              </Text>
              <Button url="/app/stores">Go to Stores</Button>
            </BlockStack>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Connect a collection
              </Text>

              <BlockStack gap="150">
                <Text as="p" variant="bodyMd" fontWeight="medium">
                  Source collection
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Button onClick={openSourceCollectionPicker}>
                    {sourceCollection ? "Change collection" : "Choose collection"}
                  </Button>
                  {sourceCollection && (
                    <Badge tone="info">{sourceCollection.title}</Badge>
                  )}
                </InlineStack>
              </BlockStack>

              <Select
                label="If a product is missing on the destination"
                options={MISSING_PRODUCT_OPTIONS}
                value={missingProductAction}
                onChange={setMissingProductAction}
                helpText="Applies when a product in the source collection hasn't been synced to that destination store yet."
              />

              <Select
                label="How should this sync?"
                options={TRIGGER_MODE_OPTIONS}
                value={triggerMode}
                onChange={setTriggerMode}
                helpText="Live syncs automatically whenever the source collection changes. Manual only syncs when you click Sync now."
              />

              <BlockStack gap="150">
                <Text as="p" variant="bodyMd" fontWeight="medium">
                  Destination store(s)
                </Text>
                <BlockStack gap="200">
                  {destStores.map((store) => (
                    <DestinationConnectRow
                      key={store.id}
                      store={{ id: store.id, label: store.shopName || store.shopDomain }}
                      selection={destSelections[store.id]}
                      priceRules={priceRules}
                      showCreateSettings={missingProductAction === "CREATE"}
                      onChange={(patch) => updateDestSelection(store.id, patch)}
                    />
                  ))}
                </BlockStack>
              </BlockStack>

              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleCreateMapping}
                  loading={isSubmitting}
                  disabled={!chosenEntries.length || !sourceCollection || hasIncompleteExisting}
                >
                  Connect collection
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {mappings.length === 0 ? (
          <Card>
            <EmptyState
              heading="No collection mappings yet"
              image=""
            >
              <p>
                Connect a collection above to start syncing it. Nothing syncs
                automatically until you do.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              headings={[
                { title: "Source Handle" },
                { title: "Source Store" },
                { title: "Dest Store" },
                { title: "Dest Title Override" },
                { title: "Missing products" },
                { title: "Trigger" },
                { title: "Status" },
                { title: "Last Synced" },
                { title: "Actions" },
              ]}
              itemCount={mappings.length}
              selectable={false}
            >
              {mappings.map((mapping: any, index: number) => (
                <IndexTable.Row
                  id={mapping.id}
                  key={mapping.id}
                  position={index}
                >
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {mapping.sourceHandle || "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.sourceStore.shopName || mapping.sourceStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.destStore.shopName || mapping.destStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {editingId === mapping.id ? (
                      <InlineStack gap="200" blockAlign="center">
                        <TextField
                          label=""
                          labelHidden
                          value={editTitle}
                          onChange={setEditTitle}
                          autoComplete="off"
                          size="slim"
                        />
                        <Button size="slim" onClick={() => handleSaveTitle(mapping.id)}>
                          Save
                        </Button>
                        <Button size="slim" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </InlineStack>
                    ) : (
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">
                          {mapping.destTitle || "Same as source"}
                        </Text>
                        <Button
                          size="slim"
                          onClick={() => {
                            setEditingId(mapping.id);
                            setEditTitle(mapping.destTitle || "");
                          }}
                        >
                          Edit
                        </Button>
                      </InlineStack>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Select
                        label=""
                        labelHidden
                        options={MISSING_PRODUCT_OPTIONS}
                        value={mapping.missingProductAction}
                        onChange={(v) => handleMissingProductActionChange(mapping.id, v)}
                      />
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Select
                        label=""
                        labelHidden
                        options={TRIGGER_MODE_OPTIONS}
                        value={mapping.triggerMode}
                        onChange={(v) => handleTriggerModeChange(mapping.id, v)}
                      />
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge
                      tone={mapping.status === "SYNCED" ? "success" : "attention"}
                    >
                      {mapping.status}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.lastSyncedAt
                      ? new Date(mapping.lastSyncedAt).toLocaleString()
                      : "Never"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      <Button
                        size="slim"
                        onClick={() => handleSyncNow(mapping.id)}
                        loading={isSubmitting}
                      >
                        Sync now
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => handleDelete(mapping.id)}
                        loading={isSubmitting}
                      >
                        Remove
                      </Button>
                    </InlineStack>
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

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <TitleBar title="Collection Mapping" />
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unexpected error loading collection mappings."}
          </Text>
          <Button url="/app/collection-mapping">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
