import type { InventorySyncRule, ProductMapping, ConnectedStore } from "@prisma/client";
import prisma from "../db.server";
import { createClientForStore } from "./shopify-client.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import { setDestinationInventoryQuantity } from "./inventory-sync.server";

type InventoryItemSnapshot = {
  inventoryItemId: string;
  variantGid: string;
  productGid: string;
  available: number;
};

type VariantMapping = {
  sourceVariantGid: string;
  destVariantGid: string;
  sourceSku?: string;
};

type RuleWithStores = InventorySyncRule & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
};

const echoMarkers = new Map<string, number>();
const ECHO_TTL_MS = 90_000;

function markerKey(shopDomain: string, variantGid: string, quantity: number) {
  return `${shopDomain}:${variantGid}:${quantity}`;
}

function markExpectedEcho(shopDomain: string, variantGid: string, quantity: number) {
  echoMarkers.set(markerKey(shopDomain, variantGid, quantity), Date.now() + ECHO_TTL_MS);
}

function consumeExpectedEcho(shopDomain: string, variantGid: string, quantity: number) {
  const now = Date.now();
  for (const [key, expiresAt] of echoMarkers.entries()) {
    if (expiresAt <= now) echoMarkers.delete(key);
  }

  const key = markerKey(shopDomain, variantGid, quantity);
  const expiresAt = echoMarkers.get(key);
  if (!expiresAt || expiresAt <= now) return false;

  echoMarkers.delete(key);
  return true;
}

function parseVariantMappings(value: string | null | undefined): VariantMapping[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseGidList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function availableFromLevels(levels: Array<{ node?: { quantities?: Array<{ name: string; quantity: number }> } }>) {
  return levels.reduce((total, edge) => {
    const available =
      edge.node?.quantities?.find((quantity) => quantity.name === "available")?.quantity ?? 0;
    return total + available;
  }, 0);
}

async function fetchInventoryItemSnapshot(
  client: ShopifyGraphQLClient,
  inventoryItemId: string,
  fallbackAvailable: number
): Promise<InventoryItemSnapshot | null> {
  const result = await client.queryWithRetry(
    `#graphql
    query GetInventoryItemForTwoWaySync($id: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevels(first: 50) {
          edges {
            node {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
        variants(first: 10) {
          edges {
            node {
              id
              product {
                id
              }
            }
          }
        }
      }
    }`,
    { id: inventoryItemId }
  );

  const inventoryItem = result.data?.inventoryItem;
  const variant = inventoryItem?.variants?.edges?.[0]?.node;
  const productGid = variant?.product?.id;
  if (!inventoryItem?.id || !variant?.id || !productGid) return null;

  const levels = inventoryItem.inventoryLevels?.edges || [];
  return {
    inventoryItemId,
    variantGid: variant.id,
    productGid,
    available: levels.length ? availableFromLevels(levels) : fallbackAvailable,
  };
}

async function fetchSourceProductScope(
  client: ShopifyGraphQLClient,
  sourceProductGid: string
): Promise<{ tags: string[]; collectionIds: string[] } | null> {
  const result = await client.queryWithRetry(
    `#graphql
    query GetInventoryScopeProduct($id: ID!) {
      product(id: $id) {
        id
        tags
        collections(first: 100) {
          nodes {
            id
          }
        }
      }
    }`,
    { id: sourceProductGid }
  );

  const product = result.data?.product;
  if (!product?.id) return null;
  return {
    tags: product.tags || [],
    collectionIds: (product.collections?.nodes || [])
      .map((collection: { id?: string }) => collection.id)
      .filter(Boolean),
  };
}

async function matchesInventoryRuleScope(
  rule: RuleWithStores,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient
) {
  if (rule.filterType === "ALL") return true;

  if (rule.filterType === "SELECTED_PRODUCTS") {
    return parseGidList(rule.filterProductIds).includes(sourceProductGid);
  }

  const scope = await fetchSourceProductScope(sourceClient, sourceProductGid);
  if (!scope) return false;

  if (rule.filterType === "SELECTED_COLLECTIONS") {
    const selectedCollections = parseGidList(rule.filterCollectionIds);
    if (!selectedCollections.length) return false;
    return selectedCollections.some((collectionId) => scope.collectionIds.includes(collectionId));
  }

  if (rule.filterType === "BY_TAGS") {
    const selectedTags = (rule.filterTags || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (!selectedTags.length) return false;
    const productTags = scope.tags.map((tag) => tag.toLowerCase());
    return selectedTags.some((tag) => productTags.includes(tag));
  }

  return false;
}

function findSourceToDestVariant(mapping: ProductMapping, sourceVariantGid: string) {
  return parseVariantMappings(mapping.variantMappings).find(
    (variantMap) => variantMap.sourceVariantGid === sourceVariantGid && variantMap.destVariantGid
  )?.destVariantGid;
}

function findDestToSourceVariant(mapping: ProductMapping, destVariantGid: string) {
  return parseVariantMappings(mapping.variantMappings).find(
    (variantMap) => variantMap.destVariantGid === destVariantGid && variantMap.sourceVariantGid
  )?.sourceVariantGid;
}

async function logInventoryResult(args: {
  rule: RuleWithStores;
  targetStoreId: string;
  sourceGid: string;
  targetVariantGid?: string;
  success: boolean;
  error?: string;
  duration: number;
  trigger?: "WEBHOOK" | "SCHEDULED";
}) {
  await prisma.syncLog.create({
    data: {
      storeId: args.targetStoreId,
      action: "UPDATE",
      resourceType: "INVENTORY",
      sourceGid: args.sourceGid,
      destGid: args.targetVariantGid,
      status: args.success ? "SUCCESS" : "FAILED",
      trigger: args.trigger || "WEBHOOK",
      message: args.success ? "Inventory synced by inventory-only rule" : undefined,
      errorDetail: args.error,
      duration: args.duration,
    },
  });
}

async function syncMappedVariant(args: {
  rule: RuleWithStores;
  changedInventoryItemId: string;
  targetStore: ConnectedStore;
  targetVariantGid: string;
  quantity: number;
  trigger?: "WEBHOOK" | "SCHEDULED";
}) {
  const start = Date.now();
  const targetClient = await createClientForStore(args.targetStore.id);
  markExpectedEcho(args.targetStore.shopDomain, args.targetVariantGid, args.quantity);
  const result = await setDestinationInventoryQuantity(
    targetClient,
    args.targetVariantGid,
    args.quantity
  );

  const success = !result.error;
  await prisma.inventorySyncRule.update({
    where: { id: args.rule.id },
    data: {
      lastRunAt: new Date(),
      lastError: success ? null : result.error,
    },
  });
  await logInventoryResult({
    rule: args.rule,
    targetStoreId: args.targetStore.id,
    sourceGid: args.changedInventoryItemId,
    targetVariantGid: args.targetVariantGid,
    success,
    error: result.error || undefined,
    duration: Date.now() - start,
    trigger: args.trigger,
  });

  return success;
}

async function syncSourceToDestination(rule: RuleWithStores, snapshot: InventoryItemSnapshot) {
  const mapping = await prisma.productMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: rule.sourceStoreId,
        destStoreId: rule.destStoreId,
        sourceProductGid: snapshot.productGid,
      },
    },
  });
  if (!mapping) return false;

  const sourceClient = await createClientForStore(rule.sourceStoreId);
  if (!(await matchesInventoryRuleScope(rule, mapping.sourceProductGid, sourceClient))) {
    return false;
  }

  const targetVariantGid = findSourceToDestVariant(mapping, snapshot.variantGid);
  if (!targetVariantGid) return false;

  return syncMappedVariant({
    rule,
    changedInventoryItemId: snapshot.inventoryItemId,
    targetStore: rule.destStore,
    targetVariantGid,
    quantity: snapshot.available,
  });
}

async function syncDestinationToSource(rule: RuleWithStores, snapshot: InventoryItemSnapshot) {
  if (rule.direction !== "TWO_WAY") return false;

  const mappings = await prisma.productMapping.findMany({
    where: {
      sourceStoreId: rule.sourceStoreId,
      destStoreId: rule.destStoreId,
      status: "SYNCED",
    },
  });

  const mapping = mappings.find((candidate) =>
    parseVariantMappings(candidate.variantMappings).some(
      (variantMap) => variantMap.destVariantGid === snapshot.variantGid
    )
  );
  if (!mapping) return false;

  const sourceClient = await createClientForStore(rule.sourceStoreId);
  if (!(await matchesInventoryRuleScope(rule, mapping.sourceProductGid, sourceClient))) {
    return false;
  }

  const targetVariantGid = findDestToSourceVariant(mapping, snapshot.variantGid);
  if (!targetVariantGid) return false;

  return syncMappedVariant({
    rule,
    changedInventoryItemId: snapshot.inventoryItemId,
    targetStore: rule.sourceStore,
    targetVariantGid,
    quantity: snapshot.available,
  });
}

export async function handleInventoryOnlyWebhook(
  shopDomain: string,
  inventoryItemId: string,
  available: number
) {
  const changedStore = await prisma.connectedStore.findUnique({
    where: { shopDomain },
  });
  if (!changedStore || changedStore.status !== "ACTIVE") return false;

  const changedClient = await createClientForStore(changedStore.id);
  const snapshot = await fetchInventoryItemSnapshot(
    changedClient,
    inventoryItemId,
    available
  );
  if (!snapshot) return false;

  if (consumeExpectedEcho(shopDomain, snapshot.variantGid, snapshot.available)) {
    console.log(
      `[InventoryOnlySync] Ignoring expected echo ${shopDomain} ${snapshot.variantGid}=${snapshot.available}`
    );
    return true;
  }

  const rules = await prisma.inventorySyncRule.findMany({
    where: {
      isActive: true,
      OR: [{ sourceStoreId: changedStore.id }, { destStoreId: changedStore.id }],
    },
    include: { sourceStore: true, destStore: true },
  });

  let handled = false;
  for (const rule of rules) {
    if (rule.sourceStoreId === changedStore.id) {
      handled = (await syncSourceToDestination(rule, snapshot)) || handled;
    } else if (rule.destStoreId === changedStore.id) {
      handled = (await syncDestinationToSource(rule, snapshot)) || handled;
    }
  }

  return handled;
}

export async function pollInventorySyncRules() {
  const rules = await prisma.inventorySyncRule.findMany({
    where: { isActive: true },
    include: { sourceStore: true, destStore: true },
    take: 5,
  });

  for (const rule of rules) {
    const mappings = await prisma.productMapping.findMany({
      where: {
        sourceStoreId: rule.sourceStoreId,
        destStoreId: rule.destStoreId,
        status: "SYNCED",
      },
      take: 25,
    });

    const sourceClient = await createClientForStore(rule.sourceStoreId);
    for (const mapping of mappings) {
      if (!(await matchesInventoryRuleScope(rule, mapping.sourceProductGid, sourceClient))) {
        continue;
      }

      for (const variantMap of parseVariantMappings(mapping.variantMappings)) {
        if (!variantMap.sourceVariantGid || !variantMap.destVariantGid) continue;
        const result = await sourceClient.queryWithRetry(
          `#graphql
          query GetVariantInventoryItem($id: ID!) {
            productVariant(id: $id) {
              inventoryItem {
                id
                inventoryLevels(first: 50) {
                  edges {
                    node {
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }`,
          { id: variantMap.sourceVariantGid }
        );
        const item = result.data?.productVariant?.inventoryItem;
        if (!item?.id) continue;
        const quantity = availableFromLevels(item.inventoryLevels?.edges || []);
        await syncMappedVariant({
          rule,
          changedInventoryItemId: item.id,
          targetStore: rule.destStore,
          targetVariantGid: variantMap.destVariantGid,
          quantity,
          trigger: "SCHEDULED",
        });
      }
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var inventoryRulePollerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var inventoryRulePollerRunning: boolean | undefined;
}

export function startInventoryRulePolling() {
  if (global.inventoryRulePollerStarted) return;
  if (process.env.INVENTORY_RULE_POLLER_DISABLED === "true") return;

  global.inventoryRulePollerStarted = true;
  const intervalMs = Number(process.env.INVENTORY_RULE_POLL_MS || 60_000);

  const tick = () => {
    if (global.inventoryRulePollerRunning) return;
    global.inventoryRulePollerRunning = true;
    void pollInventorySyncRules()
      .catch((error) => {
        console.error("[InventoryOnlySync] Poll failed:", error);
      })
      .finally(() => {
        global.inventoryRulePollerRunning = false;
      });
  };

  setInterval(tick, intervalMs);
  setTimeout(tick, 20_000);
  console.log(`[InventoryOnlySync] Started fallback poll interval=${intervalMs}ms`);
}
