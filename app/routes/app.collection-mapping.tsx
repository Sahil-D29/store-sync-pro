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
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const ownerShop = await withDbRetry(() => getAccountShop(session.shop));
    const [mappings, syncRules] = await withDbRetry(() =>
      Promise.all([
        prisma.collectionMapping.findMany({
          where: { sourceStore: { ownerShop } },
          include: {
            sourceStore: { select: { shopDomain: true, shopName: true } },
            destStore: { select: { shopDomain: true, shopName: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 100,
        }),
        prisma.syncRule.findMany({
          where: { ownerShop, isActive: true },
          select: {
            id: true,
            name: true,
            sourceStoreId: true,
            destStoreId: true,
            sourceStore: { select: { shopDomain: true, shopName: true } },
            destStore: { select: { shopDomain: true, shopName: true } },
          },
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
      syncRules,
      loadError: null as string | null,
    });
  } catch (e) {
    console.error("[CollectionMapping] Loader DB error:", (e as Error).message);
    return json({
      mappings: [],
      syncRules: [],
      loadError:
        "Couldn't load collection mappings right now (temporary connection issue). Please reload.",
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "create-mapping": {
      const syncRuleId = formData.get("syncRuleId") as string;
      const sourceCollectionGid = formData.get("sourceCollectionGid") as string;
      const sourceHandle = (formData.get("sourceHandle") as string) || "";
      const destCollectionGid = (formData.get("destCollectionGid") as string) || null;
      const missingProductAction = (formData.get("missingProductAction") as string) === "CREATE" ? "CREATE" : "SKIP";

      if (!syncRuleId || !sourceCollectionGid) {
        return json({ error: "Choose a store connection and a source collection" }, { status: 400 });
      }

      const ownerShop = await getAccountShop(session.shop);
      const rule = await prisma.syncRule.findFirst({
        where: { id: syncRuleId, ownerShop },
        select: { id: true, sourceStoreId: true, destStoreId: true },
      });

      if (!rule) {
        return json({ error: "Store connection not found" }, { status: 404 });
      }

      await prisma.collectionMapping.upsert({
        where: {
          sourceStoreId_destStoreId_sourceCollectionGid: {
            sourceStoreId: rule.sourceStoreId,
            destStoreId: rule.destStoreId,
            sourceCollectionGid,
          },
        },
        update: {
          destCollectionGid,
          syncRuleId: rule.id,
          missingProductAction,
        },
        create: {
          sourceStoreId: rule.sourceStoreId,
          destStoreId: rule.destStoreId,
          sourceCollectionGid,
          sourceHandle,
          destCollectionGid,
          syncRuleId: rule.id,
          missingProductAction,
          status: "PENDING",
        },
      });

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
      const missingProductAction = (formData.get("missingProductAction") as string) === "CREATE" ? "CREATE" : "SKIP";
      await prisma.collectionMapping.update({
        where: { id: mappingId },
        data: { missingProductAction },
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
  const { mappings, syncRules, loadError } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // ----- Create mapping form state -----
  const [selectedRuleId, setSelectedRuleId] = useState(syncRules[0]?.id || "");
  const selectedRule = useMemo(
    () => syncRules.find((r: any) => r.id === selectedRuleId),
    [syncRules, selectedRuleId]
  );
  const [sourceCollection, setSourceCollection] = useState<{ id: string; title: string; handle: string } | null>(null);
  const [destMode, setDestMode] = useState<"new" | "existing">("new");
  const [destCollection, setDestCollection] = useState<{ id: string; title: string } | null>(null);
  const [missingProductAction, setMissingProductAction] = useState("SKIP");

  // Destination collections (for "link to existing"), fetched per dest store.
  const destCollectionsFetcher = useFetcher<{ collections: Array<{ id: string; title: string; handle: string }> }>();
  const [destQuery, setDestQuery] = useState("");

  useEffect(() => {
    if (destMode === "existing" && selectedRule?.destStoreId) {
      destCollectionsFetcher.load(`/api/store-collections/${selectedRule.destStoreId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destMode, selectedRule?.destStoreId]);

  const destCollectionOptions = useMemo(() => {
    const all = destCollectionsFetcher.data?.collections || [];
    const filtered = destQuery
      ? all.filter((c) => c.title.toLowerCase().includes(destQuery.toLowerCase()))
      : all;
    return filtered.slice(0, 50).map((c) => ({ value: c.id, label: c.title }));
  }, [destCollectionsFetcher.data, destQuery]);

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
    if (!selectedRuleId || !sourceCollection) return;
    submit(
      {
        intent: "create-mapping",
        syncRuleId: selectedRuleId,
        sourceCollectionGid: sourceCollection.id,
        sourceHandle: sourceCollection.handle,
        destCollectionGid: destMode === "existing" && destCollection ? destCollection.id : "",
        missingProductAction,
      },
      { method: "POST" }
    );
    setSourceCollection(null);
    setDestCollection(null);
    setDestMode("new");
    setMissingProductAction("SKIP");
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
            Connect a collection here to keep its product order in sync between stores, or
            let mappings get created automatically the first time a collection syncs through
            an active store connection.
          </p>
        </Banner>

        {syncRules.length === 0 ? (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                No active store connections yet
              </Text>
              <Text as="p" tone="subdued">
                Create a sync rule between two stores first, then come back here to connect
                specific collections.
              </Text>
              <Button url="/app/sync-rules">Go to Sync Rules</Button>
            </BlockStack>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Connect a collection
              </Text>

              <Select
                label="Store connection"
                options={syncRules.map((r: any) => ({
                  label: `${r.sourceStore.shopName || r.sourceStore.shopDomain} → ${r.destStore.shopName || r.destStore.shopDomain} (${r.name})`,
                  value: r.id,
                }))}
                value={selectedRuleId}
                onChange={(v) => {
                  setSelectedRuleId(v);
                  setDestCollection(null);
                }}
              />

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
                label="Destination"
                options={[
                  { label: "Create a new collection", value: "new" },
                  { label: "Link to an existing collection", value: "existing" },
                ]}
                value={destMode}
                onChange={(v) => setDestMode(v as "new" | "existing")}
              />

              {destMode === "existing" && (
                <Autocomplete
                  options={destCollectionOptions}
                  selected={destCollection ? [destCollection.id] : []}
                  onSelect={(selected) => {
                    const id = selected[0];
                    const match = destCollectionsFetcher.data?.collections.find((c) => c.id === id);
                    if (match) setDestCollection({ id: match.id, title: match.title });
                  }}
                  loading={destCollectionsFetcher.state === "loading"}
                  textField={
                    <Autocomplete.TextField
                      label="Existing destination collection"
                      value={destCollection ? destCollection.title : destQuery}
                      onChange={(v) => {
                        setDestQuery(v);
                        if (destCollection) setDestCollection(null);
                      }}
                      placeholder="Search collections"
                      autoComplete="off"
                    />
                  }
                />
              )}

              <Select
                label="If a product is missing on the destination"
                options={MISSING_PRODUCT_OPTIONS}
                value={missingProductAction}
                onChange={setMissingProductAction}
                helpText="Applies when a product in the source collection hasn't been synced to the destination store yet."
              />

              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleCreateMapping}
                  loading={isSubmitting}
                  disabled={!selectedRuleId || !sourceCollection || (destMode === "existing" && !destCollection)}
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
                Connect a collection above, or mappings will appear here once collections are
                synced between stores.
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
                        disabled={!mapping.syncRuleId}
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
