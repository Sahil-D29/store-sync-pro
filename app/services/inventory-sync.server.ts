import prisma from "../db.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import {
  INVENTORY_ACTIVATE_MUTATION,
  INVENTORY_ITEM_UPDATE_MUTATION,
  INVENTORY_SET_QUANTITIES_MUTATION,
} from "../graphql/mutations";
import type { SyncRuleWithRelations } from "./product-sync.server";

interface SyncInventoryResult {
  success: boolean;
  action: "UPDATE" | "SKIP";
  sourceGid: string;
  error?: string;
  duration: number;
}

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
  const errors = result.data?.inventoryItemUpdate?.userErrors;
  return errors?.length ? errors[0].message : null;
}

async function setDestinationInventoryQuantity(
  destClient: ShopifyGraphQLClient,
  destVariantGid: string,
  quantity: number
): Promise<string | null> {
  const destLocationId = await getPrimaryLocationId(destClient);
  if (!destLocationId) return "No destination location found";

  const destVariantResult = await destClient.queryWithRetry(
    `#graphql
    query GetVariantInventory($id: ID!, $locationId: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          id
          tracked
          inventoryLevel(locationId: $locationId) {
            id
          }
        }
      }
    }`,
    { id: destVariantGid, locationId: destLocationId }
  );

  const destInventoryItem =
    destVariantResult.data?.productVariant?.inventoryItem;
  const destInventoryItemId = destInventoryItem?.id;
  if (!destInventoryItemId) return "Destination inventory item not found";

  const trackingError = await ensureInventoryTracked(
    destClient,
    destInventoryItemId,
    !!destInventoryItem.tracked
  );
  if (trackingError) return trackingError;

  if (!destInventoryItem.inventoryLevel) {
    const activateResult = await destClient.queryWithRetry(
      INVENTORY_ACTIVATE_MUTATION,
      {
        inventoryItemId: destInventoryItemId,
        locationId: destLocationId,
        available: quantity,
      }
    );
    const errors = activateResult.data?.inventoryActivate?.userErrors;
    return errors?.length ? errors[0].message : null;
  }

  const setResult = await destClient.queryWithRetry(
    INVENTORY_SET_QUANTITIES_MUTATION,
    {
      input: {
        reason: "correction",
        name: "available",
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId: destInventoryItemId,
            locationId: destLocationId,
            quantity,
          },
        ],
      },
    }
  );

  const errors = setResult.data?.inventorySetQuantities?.userErrors;
  return errors?.length ? errors[0].message : null;
}

/**
 * Sync inventory for a product's variants from source to destination.
 */
export async function syncProductInventory(
  syncRule: SyncRuleWithRelations,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncInventoryResult[]> {
  const results: SyncInventoryResult[] = [];

  const mapping = await prisma.productMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceProductGid,
      },
    },
  });

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

    if (!sourceVariant.inventoryItem?.tracked) {
      results.push({
        success: true,
        action: "SKIP",
        sourceGid: sourceVariant.id,
        duration: Date.now() - startTime,
      });
      continue;
    }

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

      results.push({
        success: !error,
        action: "UPDATE",
        sourceGid: sourceVariant.id,
        error: error || undefined,
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
  syncRule: SyncRuleWithRelations,
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

    if (!sourceInventoryItem?.tracked || !sourceVariant?.id || !sourceProductGid) {
      return {
        success: true,
        action: "SKIP",
        sourceGid: inventoryItemId,
        duration: Date.now() - startTime,
      };
    }

    const mapping = await prisma.productMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceProductGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceProductGid,
        },
      },
    });
    const variantMappings = parseVariantMappings(mapping?.variantMappings);
    const variantMap = variantMappings.find(
      (m) => m.sourceVariantGid === sourceVariant.id
    );

    if (!mapping?.destProductGid || !variantMap?.destVariantGid) {
      return {
        success: false,
        action: "SKIP",
        sourceGid: inventoryItemId,
        error: "No destination variant mapping found",
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

    return {
      success: !error,
      action: "UPDATE",
      sourceGid: inventoryItemId,
      error: error || undefined,
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
