import type { SyncRule, ConnectedStore, PriceRule } from "@prisma/client";
import prisma from "../db.server";
import { ShopifyGraphQLClient } from "./shopify-client.server";
import { GET_INVENTORY_LEVELS } from "../graphql/queries";
import {
  INVENTORY_SET_QUANTITIES_MUTATION,
  INVENTORY_ACTIVATE_MUTATION,
} from "../graphql/mutations";

type SyncRuleWithRelations = SyncRule & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
  priceRule: PriceRule | null;
};

interface SyncInventoryResult {
  success: boolean;
  action: "UPDATE" | "SKIP";
  sourceGid: string;
  error?: string;
  duration: number;
}

/**
 * Sync inventory for a product's variants from source to destination
 */
export async function syncProductInventory(
  syncRule: SyncRuleWithRelations,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncInventoryResult[]> {
  const results: SyncInventoryResult[] = [];

  // Get variant mappings
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

  const variantMappings: Array<{
    sourceVariantGid: string;
    destVariantGid: string;
    sourceSku: string;
  }> = JSON.parse(mapping.variantMappings);

  // Fetch source product variants with inventory
  const sourceResult = await sourceClient.queryWithRetry(
    `#graphql
    query GetProductInventory($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          edges {
            node {
              id
              inventoryItem {
                id
                inventoryLevels(first: 5) {
                  edges {
                    node {
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                      location {
                        id
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

  // Get destination locations (use first location)
  const destLocationsResult = await destClient.queryWithRetry(
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

  const destLocationId =
    destLocationsResult.data?.locations?.edges?.[0]?.node?.id;
  if (!destLocationId) {
    return [
      {
        success: false,
        action: "SKIP",
        sourceGid: sourceProductGid,
        error: "No destination location found",
        duration: 0,
      },
    ];
  }

  for (const sourceEdge of sourceResult.data.product.variants.edges) {
    const sourceVariant = sourceEdge.node;
    const startTime = Date.now();

    // Find destination variant
    const variantMap = variantMappings.find(
      (m) => m.sourceVariantGid === sourceVariant.id
    );
    if (!variantMap?.destVariantGid) continue;

    // Get source available quantity
    const sourceLevel =
      sourceVariant.inventoryItem?.inventoryLevels?.edges?.[0]?.node;
    const sourceAvailable =
      sourceLevel?.quantities?.find((q: any) => q.name === "available")
        ?.quantity ?? 0;

    // Get destination inventory item ID + whether it's stocked at the dest location
    const destVariantResult = await destClient.queryWithRetry(
      `#graphql
      query GetVariantInventory($id: ID!, $locationId: ID!) {
        productVariant(id: $id) {
          inventoryItem {
            id
            inventoryLevel(locationId: $locationId) {
              id
            }
          }
        }
      }`,
      { id: variantMap.destVariantGid, locationId: destLocationId }
    );

    const destInventoryItem =
      destVariantResult.data?.productVariant?.inventoryItem;
    const destInventoryItemId = destInventoryItem?.id;
    if (!destInventoryItemId) {
      results.push({
        success: false,
        action: "SKIP",
        sourceGid: sourceVariant.id,
        error: "Destination inventory item not found",
        duration: Date.now() - startTime,
      });
      continue;
    }

    // If the item isn't stocked at the destination location yet (common right
    // after a product is created), activate it there with the starting
    // quantity. inventorySetQuantities can't set a quantity on an item that
    // isn't activated at the location, which is why inventory looked "not
    // tracked" before.
    try {
      if (!destInventoryItem.inventoryLevel) {
        const activateResult = await destClient.queryWithRetry(
          INVENTORY_ACTIVATE_MUTATION,
          {
            inventoryItemId: destInventoryItemId,
            locationId: destLocationId,
            available: sourceAvailable,
          }
        );

        const activateErrors =
          activateResult.data?.inventoryActivate?.userErrors;
        if (activateErrors?.length) {
          results.push({
            success: false,
            action: "UPDATE",
            sourceGid: sourceVariant.id,
            error: activateErrors[0].message,
            duration: Date.now() - startTime,
          });
        } else {
          results.push({
            success: true,
            action: "UPDATE",
            sourceGid: sourceVariant.id,
            duration: Date.now() - startTime,
          });
        }
        continue;
      }

      // Already stocked at this location — update the available quantity.
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
                quantity: sourceAvailable,
              },
            ],
          },
        }
      );

      if (setResult.data?.inventorySetQuantities?.userErrors?.length) {
        results.push({
          success: false,
          action: "UPDATE",
          sourceGid: sourceVariant.id,
          error:
            setResult.data.inventorySetQuantities.userErrors[0].message,
          duration: Date.now() - startTime,
        });
      } else {
        results.push({
          success: true,
          action: "UPDATE",
          sourceGid: sourceVariant.id,
          duration: Date.now() - startTime,
        });
      }
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
 * Sync inventory for a single inventory item (from webhook)
 */
export async function syncInventoryItem(
  syncRule: SyncRuleWithRelations,
  inventoryItemId: string,
  available: number,
  destClient: ShopifyGraphQLClient
): Promise<SyncInventoryResult> {
  const startTime = Date.now();

  try {
    // Find which product/variant this inventory item belongs to
    // We need to look up the variant by inventory item on source, then find dest mapping
    // For webhook-triggered sync, we need to find the mapping
    const destLocationsResult = await destClient.queryWithRetry(
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

    const destLocationId =
      destLocationsResult.data?.locations?.edges?.[0]?.node?.id;
    if (!destLocationId) {
      return {
        success: false,
        action: "SKIP",
        sourceGid: inventoryItemId,
        error: "No destination location found",
        duration: Date.now() - startTime,
      };
    }

    // For now, log the webhook and handle via full product sync
    // Full inventory item mapping requires additional tracking
    return {
      success: true,
      action: "SKIP",
      sourceGid: inventoryItemId,
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
