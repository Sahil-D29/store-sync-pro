import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Box,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { withDbRetry } from "../utils/db-retry.server";
import { getAccountShop } from "../services/store-management.server";
import { triggerManualCollectionSync } from "../services/collection-sync.server";
import { createClientForStore } from "../services/shopify-client.server";

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

type SyncRunError = {
  sourceGid?: string;
  error?: string;
};

type SyncJobView = {
  jobId: string;
  total: number;
  synced: number;
  failed: number;
  skipped: number;
  status: string;
  errors: SyncRunError[];
};

function normalizeSyncErrors(errors: unknown): SyncRunError[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => {
    if (typeof entry === "string") return { error: entry };
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return {
        sourceGid: typeof record.sourceGid === "string" ? record.sourceGid : undefined,
        error: typeof record.error === "string" ? record.error : JSON.stringify(record),
      };
    }
    return { error: String(entry) };
  });
}

function sourceLabel(sourceGid?: string) {
  if (!sourceGid) return "Product";
  return sourceGid.replace("gid://shopify/Product/", "#").replace("gid://shopify/Collection/", "Collection #");
}

function parseShopifyCollectionGid(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const gidMatch = trimmed.match(/gid:\/\/shopify\/Collection\/(\d+)/i);
  if (gidMatch) return `gid://shopify/Collection/${gidMatch[1]}`;

  const adminUrlMatch = trimmed.match(/\/collections\/(\d+)/i);
  if (adminUrlMatch) return `gid://shopify/Collection/${adminUrlMatch[1]}`;

  if (/^\d{6,}$/.test(trimmed)) return `gid://shopify/Collection/${trimmed}`;

  return "";
}

function collectionNumberFromGid(gid: string) {
  return gid.replace("gid://shopify/Collection/", "");
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
    const [sourceStore, mappings, destStores, priceRules] = await withDbRetry(() =>
      Promise.all([
        prisma.connectedStore.findFirst({
          where: { shopDomain: ownerShop, ownerShop, status: "ACTIVE" },
          select: { id: true, shopDomain: true, shopName: true },
        }),
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
      sourceStore,
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
      sourceStore: null,
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
      let sourceHandle = (formData.get("sourceHandle") as string) || "";
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
      const sourceStore = await prisma.connectedStore.findFirst({
        where: { shopDomain: ownerShop, ownerShop, status: "ACTIVE" },
        select: { id: true },
      });
      if (!sourceStore) {
        return json({ error: "Source store not found" }, { status: 404 });
      }

      const sourceClient = await createClientForStore(sourceStore.id);
      const sourceCollectionResult: any = await sourceClient.queryWithRetry(
        `#graphql
        query ValidateSourceCollection($id: ID!) {
          collection(id: $id) {
            id
            title
            handle
          }
        }`,
        { id: sourceCollectionGid }
      );
      if (sourceCollectionResult.errors?.length || !sourceCollectionResult.data?.collection) {
        return json(
          {
            error: `Selected source collection was not found on ${ownerShop}. Choose it from the source collection list again.`,
          },
          { status: 400 }
        );
      }
      sourceHandle = sourceCollectionResult.data.collection.handle || sourceHandle;

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
            sourceHandle,
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
      const result = await triggerManualCollectionSync(mappingId);
      return json({ success: true, started: true, ...result });
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
  const { sourceStore, mappings, destStores, priceRules, loadError } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const syncFetcher = useFetcher<{ success?: boolean; jobId?: string; queued?: number; error?: string }>();
  const sourceCollectionsFetcher = useFetcher<{ collections: Array<{ id: string; title: string; handle: string }>; error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [syncJobs, setSyncJobs] = useState<Record<string, SyncJobView>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

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
  const [sourceQuery, setSourceQuery] = useState("");
  const [missingProductAction, setMissingProductAction] = useState("SKIP");
  const [triggerMode, setTriggerMode] = useState("REALTIME");
  const pastedSourceCollectionGid = useMemo(() => parseShopifyCollectionGid(sourceQuery), [sourceQuery]);
  const selectedSourceCollection = sourceCollection || (pastedSourceCollectionGid
    ? {
        id: pastedSourceCollectionGid,
        title: `Collection #${collectionNumberFromGid(pastedSourceCollectionGid)}`,
        handle: "",
      }
    : null);

  const chosenEntries = Object.entries(destSelections).filter(([, s]) => s.checked);
  const hasIncompleteExisting = chosenEntries.some(
    ([, s]) => s.destMode === "existing" && !s.destCollection
  );

  useEffect(() => {
    if (sourceStore?.id) {
      const params = new URLSearchParams();
      if (sourceQuery.trim()) params.set("q", sourceQuery.trim());
      const search = params.toString();
      sourceCollectionsFetcher.load(
        `/api/store-collections/${sourceStore.id}${search ? `?${search}` : ""}`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceStore?.id, sourceQuery]);

  const sourceCollectionOptions = useMemo(() => {
    const all = sourceCollectionsFetcher.data?.collections || [];
    const query = sourceQuery.toLowerCase();
    const filtered = query
      ? all.filter((collection) =>
          `${collection.title} ${collection.handle}`.toLowerCase().includes(query)
        )
      : all;
    return filtered.slice(0, 50).map((collection) => ({
      value: collection.id,
      label: collection.title,
    }));
  }, [sourceCollectionsFetcher.data, sourceQuery]);

  const usePastedSourceCollection = useCallback(() => {
    if (!pastedSourceCollectionGid) return;
    setSourceCollection({
      id: pastedSourceCollectionGid,
      title: `Collection #${collectionNumberFromGid(pastedSourceCollectionGid)}`,
      handle: "",
    });
  }, [pastedSourceCollectionGid]);

  const handleCreateMapping = () => {
    if (!chosenEntries.length || !selectedSourceCollection || hasIncompleteExisting) return;
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
    fd.set("sourceCollectionGid", selectedSourceCollection.id);
    fd.set("sourceHandle", selectedSourceCollection.handle);
    fd.set("missingProductAction", missingProductAction);
    fd.set("triggerMode", triggerMode);
    submit(fd, { method: "POST" });

    setSourceCollection(null);
    setSourceQuery("");
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
    syncFetcher.submit({ intent: "sync-now", mappingId }, { method: "POST" });
  };

  const pollJobStatus = useCallback((mappingId: string, jobId: string) => {
    if (pollTimers.current[mappingId]) clearInterval(pollTimers.current[mappingId]);

    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/sync-job/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        setSyncJobs((prev) => ({
          ...prev,
          [mappingId]: {
            jobId,
            total: data.totalProducts,
            synced: data.syncedProducts,
            failed: data.failedProducts,
            skipped: data.skippedProducts,
            status: data.status,
            errors: normalizeSyncErrors(data.errors),
          },
        }));
        if (data.status !== "RUNNING") {
          clearInterval(pollTimers.current[mappingId]);
          delete pollTimers.current[mappingId];
        }
      } catch {
        // Ignore transient polling errors.
      }
    }, 2000);

    pollTimers.current[mappingId] = timer;
  }, []);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      Object.values(timers).forEach(clearInterval);
    };
  }, []);

  useEffect(() => {
    if (!syncFetcher.data?.success || !syncFetcher.data.jobId) return;

    const mappingId = syncFetcher.formData?.get("mappingId") as string | null;
    if (!mappingId) return;

    setSyncJobs((prev) => ({
      ...prev,
      [mappingId]: {
        jobId: syncFetcher.data!.jobId!,
        total: syncFetcher.data!.queued || 0,
        synced: 0,
        failed: 0,
        skipped: 0,
        status: "RUNNING",
        errors: [],
      },
    }));
    pollJobStatus(mappingId, syncFetcher.data.jobId);
  }, [syncFetcher.data, syncFetcher.formData, pollJobStatus]);

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

  const renderSyncJob = (job?: SyncJobView) => {
    if (!job) return null;
    const processed = job.synced + job.failed + job.skipped;
    const progress = job.total > 0 ? Math.round((processed / job.total) * 100) : 0;

    return (
      <Box paddingBlockStart="200">
        <BlockStack gap="100">
          <ProgressBar
            progress={progress}
            size="small"
            tone={job.status === "COMPLETED" ? "success" : job.status === "FAILED" ? "critical" : "highlight"}
          />
          <Text as="span" variant="bodySm" tone={job.failed > 0 || job.status === "FAILED" ? "critical" : "subdued"}>
            {job.status === "RUNNING"
              ? `Syncing... ${processed}/${job.total} products`
              : job.status === "COMPLETED"
                ? `Done! ${job.synced} synced${job.skipped ? `, ${job.skipped} skipped` : ""}`
                : job.status === "FAILED"
                  ? `Sync failed after ${processed}/${job.total} products`
                  : `Completed with ${job.failed} failed, ${job.synced} synced${job.skipped ? `, ${job.skipped} skipped` : ""}`}
          </Text>
          {job.errors.length > 0 && (
            <BlockStack gap="050">
              {job.errors.slice(0, 8).map((error, errorIndex) => (
                <Text
                  as="span"
                  key={`${error.sourceGid || "error"}-${errorIndex}`}
                  variant="bodySm"
                  tone="critical"
                >
                  {sourceLabel(error.sourceGid)}: {error.error || "Unknown error"}
                </Text>
              ))}
              {job.errors.length > 8 && (
                <Text as="span" variant="bodySm" tone="subdued">
                  +{job.errors.length - 8} more errors in Sync Logs
                </Text>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Box>
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
        {syncFetcher.data?.error && (
          <Banner tone="critical" title="Error">
            <p>{syncFetcher.data.error}</p>
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
                <InlineStack gap="200" blockAlign="start">
                  <div style={{ flex: 1 }}>
                    <Autocomplete
                      options={sourceCollectionOptions}
                      selected={sourceCollection ? [sourceCollection.id] : []}
                      onSelect={(selected) => {
                        const id = selected[0];
                        const match = sourceCollectionsFetcher.data?.collections.find((collection) => collection.id === id);
                        if (match) {
                          setSourceCollection(match);
                          setSourceQuery(match.title);
                        }
                      }}
                      loading={sourceCollectionsFetcher.state === "loading"}
                      textField={
                        <Autocomplete.TextField
                          label=""
                          labelHidden
                          value={sourceCollection ? sourceCollection.title : sourceQuery}
                          onChange={(value) => {
                            setSourceQuery(value);
                            if (sourceCollection) setSourceCollection(null);
                          }}
                          placeholder={
                            sourceStore
                              ? `Search ${sourceStore.shopName || sourceStore.shopDomain} collections or paste a collection URL`
                              : "Source store not connected"
                          }
                          autoComplete="off"
                        />
                      }
                    />
                  </div>
                  <Button onClick={usePastedSourceCollection} disabled={!pastedSourceCollectionGid}>
                    Use ID/URL
                  </Button>
                </InlineStack>
                {pastedSourceCollectionGid && !sourceCollection && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Ready to use Collection #{collectionNumberFromGid(pastedSourceCollectionGid)}. It will be checked on the source store before saving.
                  </Text>
                )}
                {sourceCollectionsFetcher.data?.error && (
                  <Text as="p" variant="bodySm" tone="critical">
                    {sourceCollectionsFetcher.data.error}
                  </Text>
                )}
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
                  disabled={!chosenEntries.length || !selectedSourceCollection || hasIncompleteExisting}
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
                        loading={
                          syncJobs[mapping.id]?.status === "RUNNING" ||
                          (syncFetcher.state !== "idle" && syncFetcher.formData?.get("mappingId") === mapping.id)
                        }
                        disabled={syncJobs[mapping.id]?.status === "RUNNING"}
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
                    {renderSyncJob(syncJobs[mapping.id])}
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
