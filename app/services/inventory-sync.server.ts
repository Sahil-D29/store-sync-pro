import { randomUUID } from "crypto";
import prisma from "../db.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import {
  INVENTORY_ACTIVATE_MUTATION,
  INVENTORY_ADJUST_QUANTITIES_MUTATION,
  INVENTORY_ITEM_UPDATE_MUTATION,
} from "../graphql/mutations";

interface InventorySyncScope {
  sourceStoreId: string;
  destStoreId: string;
}

interface SyncInventoryResult {
  success: boolean;
  action: "UPDATE" | "SKIP";
  sourceGid: string;
  error?: string;
  duration: number;
}

type InventoryWriteMethod = "GRAPHQL" | "REST_FALLBACK" | "ACTIVATE" | "NOOP";

interface InventoryWriteResult {
  error: string | null;
  method?: InventoryWriteMethod;
}

type ProductMappingRecord = Awaited<
  ReturnType<typeof prisma.productMapping.findUnique>
>;

type ProductVariantForMapping = {
  id: string;
  sku: string | null;
  title: string | null;
};

const inventoryRestFallbackShops = new Set<string>();

function parseVariantMappings(value: string | null | undefined): Array<{
  sourceVariantGid: string;
  destVariantGid: string;
  sourceSku: string;
}> {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function normalizeText(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function matchVariants(
  sourceVariants: ProductVariantForMapping[],
  destVariants: ProductVariantForMapping[]
): Array<{ sourceVariantGid: string; destVariantGid: string; sourceSku: string }> {
  const usedDestIds = new Set<string>();
  const result: Array<{ sourceVariantGid: string; destVariantGid: string; sourceSku: string }> = [];
  const unmatchedSource: ProductVariantForMapping[] = [];

  const destBySku = new Map<string, ProductVariantForMapping>();
  const destByTitle = new Map<string, ProductVariantForMapping>();
  for (const destVariant of destVariants) {
    const sku = normalizeText(destVariant.sku);
    const title = normalizeText(destVariant.title);
    if (sku) destBySku.set(sku, destVariant);
    if (title) destByTitle.set(title, destVariant);
  }

  for (const sourceVariant of sourceVariants) {
    const sku = normalizeText(sourceVariant.sku);
    const title = normalizeText(sourceVariant.title);
    const destVariant =
      (sku ? destBySku.get(sku) : undefined) ||
      (title ? destByTitle.get(title) : undefined);

    if (destVariant && !usedDestIds.has(destVariant.id)) {
      result.push({
        sourceVariantGid: sourceVariant.id,
        destVariantGid: destVariant.id,
        sourceSku: sourceVariant.sku || "",
      });
      usedDestIds.add(destVariant.id);
    } else {
      unmatchedSource.push(sourceVariant);
    }
  }

  const unmatchedDest = destVariants.filter(
    (destVariant) => !usedDestIds.has(destVariant.id)
  );
  unmatchedSource.forEach((sourceVariant, index) => {
    result.push({
      sourceVariantGid: sourceVariant.id,
      destVariantGid: unmatchedDest[index]?.id || "",
      sourceSku: sourceVariant.sku || "",
    });
  });

  return result;
}

async function fetchProductForInventoryMapping(
  client: ShopifyGraphQLClient,
  productGid: string
): Promise<{
  id: string;
  handle: string;
  variants: ProductVariantForMapping[];
} | null> {
  const result = await client.queryWithRetry(
    `#graphql
    query GetProductForInventoryMapping($id: ID!) {
      product(id: $id) {
        id
        handle
        variants(first: 100) {
          edges {
            node {
              id
              sku
              title
            }
          }
        }
      }
    }`,
    { id: productGid }
  );

  const product = result.data?.product;
  if (!product) return null;

  return {
    id: product.id,
    handle: product.handle,
    variants: product.variants.edges.map((edge: any) => edge.node),
  };
}

async function fetchDestinationProductForInventoryMapping(
  client: ShopifyGraphQLClient,
  destProductGid: string | null | undefined,
  sourceHandle: string | null | undefined
): Promise<{
  id: string;
  variants: ProductVariantForMapping[];
} | null> {
  if (destProductGid) {
    const result = await client.queryWithRetry(
      `#graphql
      query GetDestinationProductForInventoryMapping($id: ID!) {
        product(id: $id) {
          id
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
              }
            }
          }
        }
      }`,
      { id: destProductGid }
    );

    const product = result.data?.product;
    if (product) {
      return {
        id: product.id,
        variants: product.variants.edges.map((edge: any) => edge.node),
      };
    }
  }

  if (!sourceHandle) return null;

  const byHandleResult = await client.queryWithRetry(
    `#graphql
    query GetDestinationProductByHandleForInventoryMapping($handle: String!) {
      productByHandle(handle: $handle) {
        id
        variants(first: 100) {
          edges {
            node {
              id
              sku
              title
            }
          }
        }
      }
    }`,
    { handle: sourceHandle }
  );

  const product = byHandleResult.data?.productByHandle;
  if (!product) return null;

  return {
    id: product.id,
    variants: product.variants.edges.map((edge: any) => edge.node),
  };
}

async function repairVariantMappings(
  syncScope: InventorySyncScope,
  sourceProductGid: string,
  existingMapping: ProductMappingRecord,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
) {
  const sourceProduct = await fetchProductForInventoryMapping(
    sourceClient,
    sourceProductGid
  );
  if (!sourceProduct) return existingMapping;

  const destProduct = await fetchDestinationProductForInventoryMapping(
    destClient,
    existingMapping?.destProductGid,
    existingMapping?.sourceHandle || sourceProduct.handle
  );
  if (!destProduct) return existingMapping;

  const variantMappings = matchVariants(
    sourceProduct.variants,
    destProduct.variants
  );
  const hasDestinationVariants = variantMappings.some(
    (mapping) => !!mapping.destVariantGid
  );
  if (!hasDestinationVariants) return existingMapping;

  return prisma.productMapping.upsert({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: syncScope.sourceStoreId,
        destStoreId: syncScope.destStoreId,
        sourceProductGid,
      },
    },
    update: {
      destProductGid: destProduct.id,
      sourceHandle: existingMapping?.sourceHandle || sourceProduct.handle,
      variantMappings: JSON.stringify(variantMappings),
      status: "SYNCED",
      lastSyncedAt: new Date(),
    },
    create: {
      sourceStoreId: syncScope.sourceStoreId,
      destStoreId: syncScope.destStoreId,
      sourceProductGid,
      destProductGid: destProduct.id,
      sourceHandle: sourceProduct.handle,
      variantMappings: JSON.stringify(variantMappings),
      status: "SYNCED",
      lastSyncedAt: new Date(),
    },
  });
}

function availableQuantityFromLevels(
  levels: Array<{
    node?: { quantities?: Array<{ name: string; quantity: number }> };
  }>
) {
  return levels.reduce((sum, edge) => {
    const quantity =
      edge.node?.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
    return sum + quantity;
  }, 0);
}

function availableQuantityFromInventoryLevel(
  inventoryLevel: { quantities?: Array<{ name: string; quantity: number }> } | null | undefined
) {
  return (
    inventoryLevel?.quantities?.find((quantity) => quantity.name === "available")
      ?.quantity ?? 0
  );
}

function shouldUseRestInventoryFallback(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("@idempotent") ||
    normalized.includes("idempotent directive") ||
    normalized.includes("inventorychangeinput") ||
    normalized.includes("inventoryquantityinput") ||
    normalized.includes("changefromquantity") ||
    normalized.includes("change_from_quantity_stale")
  );
}

function restIdFromShopifyGid(gid: string, resourceName: string) {
  const match = gid.match(/\/(\d+)$/);
  if (!match) {
    throw new Error(`Cannot convert ${resourceName} GID to REST ID: ${gid}`);
  }

  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : match[1];
}

function inventoryWriteStatus(write: InventoryWriteResult) {
  if (write.error) return `error=${write.error}`;
  return write.method === "REST_FALLBACK" ? "REST fallback ok" : "ok";
}

async function getPrimaryLocationId(
  client: ShopifyGraphQLClient
): Promise<string | null> {
  const result = await client.queryWithRetry(
    `#graphql
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }`
  );

  return result.data?.locations?.edges?.[0]?.node?.id || null;
}

async function ensureInventoryTracked(
  destClient: ShopifyGraphQLClient,
  inventoryItemId: string,
  tracked: boolean
): Promise<string | null> {
  if (tracked) return null;

  const result = await destClient.queryWithRetry(INVENTORY_ITEM_UPDATE_MUTATION, {
    id: inventoryItemId,
    input: { tracked: true },
  });
  if (result.errors?.length) return result.errors[0].message;
  const errors = result.data?.inventoryItemUpdate?.userErrors;
  return errors?.length ? errors[0].message : null;
}

async function setInventoryLevelViaRest(
  destClient: ShopifyGraphQLClient,
  destInventoryItemId: string,
  destLocationId: string,
  quantity: number
): Promise<InventoryWriteResult> {
  try {
    await destClient.restPost("inventory_levels/set.json", {
      inventory_item_id: restIdFromShopifyGid(
        destInventoryItemId,
        "inventory item"
      ),
      location_id: restIdFromShopifyGid(destLocationId, "location"),
      available: quantity,
      disconnect_if_necessary: false,
    });

    console.log(
      `[InventorySync] REST fallback ok for destination inventory item ${destInventoryItemId} at ${destLocationId}: ${quantity}`
    );

    return { error: null, method: "REST_FALLBACK" };
  } catch (error) {
    return {
      error: `REST fallback failed: ${(error as Error).message}`,
      method: "REST_FALLBACK",
    };
  }
}

async function setDestinationInventoryQuantity(
  destClient: ShopifyGraphQLClient,
  destVariantGid: string,
  quantity: number
): Promise<InventoryWriteResult> {
  const destLocationId = await getPrimaryLocationId(destClient);
  if (!destLocationId) return { error: "No destination location found" };

  const destVariantResult = await destClient.queryWithRetry(
    `#graphql
    query GetVariantInventory($id: ID!, $locationId: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          id
          tracked
          inventoryLevel(locationId: $locationId) {
            id
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }`,
    { id: destVariantGid, locationId: destLocationId }
  );
  if (destVariantResult.errors?.length) {
    return { error: destVariantResult.errors[0].message };
  }

  const destInventoryItem =
    destVariantResult.data?.productVariant?.inventoryItem;
  const destInventoryItemId = destInventoryItem?.id;
  if (!destInventoryItemId) {
    return { error: "Destination inventory item not found" };
  }

  const trackingError = await ensureInventoryTracked(
    destClient,
    destInventoryItemId,
    !!destInventoryItem.tracked
  );
  if (trackingError) return { error: trackingError };

  if (!destInventoryItem.inventoryLevel) {
    const activateResult = await destClient.queryWithRetry(
      INVENTORY_ACTIVATE_MUTATION,
      {
        inventoryItemId: destInventoryItemId,
        locationId: destLocationId,
        available: quantity,
      }
    );
    if (activateResult.errors?.length) {
      return { error: activateResult.errors[0].message };
    }
    const errors = activateResult.data?.inventoryActivate?.userErrors;
    return {
      error: errors?.length ? errors[0].message : null,
      method: "ACTIVATE",
    };
  }

  const changeFromQuantity = availableQuantityFromInventoryLevel(
    destInventoryItem.inventoryLevel
  );

  console.log(
    `[InventorySync] Setting destination inventory item ${destInventoryItemId} at ${destLocationId}: ${changeFromQuantity} -> ${quantity}`
  );

  const delta = quantity - changeFromQuantity;
  let writeMethod: InventoryWriteMethod = "GRAPHQL";
  if (delta === 0) {
    console.log(
      `[InventorySync] Destination inventory item ${destInventoryItemId} already has quantity ${quantity}; skipping adjustment`
    );
    return { error: null, method: "NOOP" };
  } else {
    const destShop = destClient.getShopDomain();

    if (inventoryRestFallbackShops.has(destShop)) {
      console.log(
        `[InventorySync] Using REST fallback for ${destShop} inventory item ${destInventoryItemId}; GraphQL fallback flag already set`
      );
      const restWrite = await setInventoryLevelViaRest(
        destClient,
        destInventoryItemId,
        destLocationId,
        quantity
      );
      if (restWrite.error) return restWrite;
      writeMethod = "REST_FALLBACK";
    } else {
      const adjustResult = await destClient.queryWithRetry(
        INVENTORY_ADJUST_QUANTITIES_MUTATION,
        {
          input: {
            reason: "correction",
            name: "available",
            referenceDocumentUri: `dorec-store-sync://inventory-sync/${randomUUID()}`,
            changes: [
              {
                inventoryItemId: destInventoryItemId,
                locationId: destLocationId,
                delta,
                changeFromQuantity,
              },
            ],
          },
          idempotencyKey: randomUUID(),
        }
      );

      const graphqlError =
        adjustResult.errors?.[0]?.message ||
        adjustResult.data?.inventoryAdjustQuantities?.userErrors?.[0]?.message;

      if (graphqlError) {
        if (shouldUseRestInventoryFallback(graphqlError)) {
          inventoryRestFallbackShops.add(destShop);
          console.log(
            `[InventorySync] GraphQL inventory write for ${destShop} hit the directive/compare guard; using REST fallback for this shop.`
          );
          const restWrite = await setInventoryLevelViaRest(
            destClient,
            destInventoryItemId,
            destLocationId,
            quantity
          );
          if (restWrite.error) return restWrite;
          writeMethod = "REST_FALLBACK";
        } else {
          return { error: graphqlError };
        }
      }
    }
  }

  const verifyResult = await destClient.queryWithRetry(
    `#graphql
    query VerifyInventoryQuantity($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }`,
    { inventoryItemId: destInventoryItemId, locationId: destLocationId }
  );
  if (verifyResult.errors?.length) {
    return { error: verifyResult.errors[0].message };
  }

  const verifiedQuantity =
    verifyResult.data?.inventoryItem?.inventoryLevel?.quantities?.find(
      (q: { name: string; quantity: number }) => q.name === "available"
    )?.quantity;

  if (verifiedQuantity !== quantity) {
    return {
      error: `Inventory write did not stick: destination has ${verifiedQuantity ?? "unknown"}, expected ${quantity}`,
    };
  }

  return {
    error: null,
    method: writeMethod,
  };
}

/**
 * Sync inventory for a product's variants from source to destination.
 */
export async function syncProductInventory(
  syncRule: InventorySyncScope,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncInventoryResult[]> {
  const results: SyncInventoryResult[] = [];

  let mapping = await prisma.productMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceProductGid,
      },
    },
  });

  if (!mapping?.variantMappings || !mapping.destProductGid) {
    mapping = await repairVariantMappings(
      syncRule,
      sourceProductGid,
      mapping,
      sourceClient,
      destClient
    );
  }

  if (!mapping?.variantMappings || !mapping.destProductGid) {
    return [
      {
        success: false,
        action: "SKIP",
        sourceGid: sourceProductGid,
        error: "No product mapping found",
        duration: 0,
      },
    ];
  }

  const variantMappings = parseVariantMappings(mapping.variantMappings);
  const sourceResult = await sourceClient.queryWithRetry(
    `#graphql
    query GetProductInventory($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          edges {
            node {
              id
              inventoryQuantity
              inventoryItem {
                id
                tracked
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
          }
        }
      }
    }`,
    { id: sourceProductGid }
  );

  if (!sourceResult.data?.product) return results;

  for (const sourceEdge of sourceResult.data.product.variants.edges) {
    const sourceVariant = sourceEdge.node;
    const startTime = Date.now();
    const variantMap = variantMappings.find(
      (m) => m.sourceVariantGid === sourceVariant.id
    );
    if (!variantMap?.destVariantGid) continue;

    try {
      const levels = sourceVariant.inventoryItem?.inventoryLevels?.edges || [];
      const sourceAvailable = levels.length
        ? availableQuantityFromLevels(levels)
        : sourceVariant.inventoryQuantity ?? 0;
      const error = await setDestinationInventoryQuantity(
        destClient,
        variantMap.destVariantGid,
        sourceAvailable
      );

      console.log(
        `[InventorySync] Product ${sourceProductGid} variant ${sourceVariant.id} -> ${variantMap.destVariantGid}: available=${sourceAvailable} ${inventoryWriteStatus(error)}`
      );

      results.push({
        success: !error.error,
        action: "UPDATE",
        sourceGid: sourceVariant.id,
        error: error.error || undefined,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      results.push({
        success: false,
        action: "UPDATE",
        sourceGid: sourceVariant.id,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      });
    }
  }

  return results;
}

/**
 * Sync inventory for a single inventory item from an inventory webhook.
 */
export async function syncInventoryItem(
  syncRule: InventorySyncScope,
  inventoryItemId: string,
  available: number,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncInventoryResult> {
  const startTime = Date.now();

  try {
    const sourceResult = await sourceClient.queryWithRetry(
      `#graphql
      query GetInventoryItemVariant($id: ID!) {
        inventoryItem(id: $id) {
          id
          tracked
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

    const sourceInventoryItem = sourceResult.data?.inventoryItem;
    const sourceVariant =
      sourceInventoryItem?.variants?.edges?.[0]?.node || null;
    const sourceProductGid = sourceVariant?.product?.id;

    if (!sourceInventoryItem || !sourceVariant?.id || !sourceProductGid) {
      return {
        success: false,
        action: "SKIP",
        sourceGid: inventoryItemId,
        error: !sourceInventoryItem
          ? "Source inventory item not found"
          : "Source variant/product not found for inventory item",
        duration: Date.now() - startTime,
      };
    }

    let mapping = await prisma.productMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceProductGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceProductGid,
        },
      },
    });
    let variantMappings = parseVariantMappings(mapping?.variantMappings);
    let variantMap = variantMappings.find(
      (m) => m.sourceVariantGid === sourceVariant.id
    );

    if (!mapping?.destProductGid || !variantMap?.destVariantGid) {
      mapping = await repairVariantMappings(
        syncRule,
        sourceProductGid,
        mapping,
        sourceClient,
        destClient
      );
      variantMappings = parseVariantMappings(mapping?.variantMappings);
      variantMap = variantMappings.find(
        (m) => m.sourceVariantGid === sourceVariant.id
      );
    }

    if (!mapping?.destProductGid || !variantMap?.destVariantGid) {
      console.log(
        `[InventorySync] Skipping inventory item ${inventoryItemId}; no destination variant mapping found for source variant ${sourceVariant.id}`
      );
      return {
        success: true,
        action: "SKIP",
        sourceGid: inventoryItemId,
        duration: Date.now() - startTime,
      };
    }

    const error = await setDestinationInventoryQuantity(
      destClient,
      variantMap.destVariantGid,
      sourceInventoryItem.inventoryLevels?.edges?.length
        ? availableQuantityFromLevels(sourceInventoryItem.inventoryLevels.edges)
        : available
    );

    console.log(
      `[InventorySync] Item ${inventoryItemId} variant ${sourceVariant.id} -> ${variantMap.destVariantGid}: available=${
        sourceInventoryItem.inventoryLevels?.edges?.length
          ? availableQuantityFromLevels(sourceInventoryItem.inventoryLevels.edges)
          : available
      } ${inventoryWriteStatus(error)}`
    );

    return {
      success: !error.error,
      action: "UPDATE",
      sourceGid: inventoryItemId,
      error: error.error || undefined,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "SKIP",
      sourceGid: inventoryItemId,
      error: (error as Error).message,
      duration: Date.now() - startTime,
    };
  }
}
