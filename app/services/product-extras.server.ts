import type { ShopifyGraphQLClient } from "./shopify-client.server";
import type { SyncRuleWithRelations } from "./product-sync.server";
import { syncProductInventory } from "./inventory-sync.server";
import { syncMetafields, fetchResourceMetafields } from "./metafield-sync.server";
import { syncProductImages } from "./media-sync.server";

/**
 * After a product is synced, handle metafields, images, and inventory.
 * Shared by webhook/manual product sync (sync-engine.server.ts) and
 * on-the-fly product creation during collection sync (collection-sync.server.ts).
 */
export async function syncProductExtras(
  rule: SyncRuleWithRelations,
  sourceProductGid: string,
  destProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<string[]> {
  const errors: string[] = [];

  // Sync metafields if enabled
  if (rule.syncMetafields) {
    try {
      const metafields = await fetchResourceMetafields(sourceProductGid, sourceClient);
      if (metafields.length > 0) {
        const mfResult = await syncMetafields(destProductGid, metafields, destClient, "PRODUCT");
        if (!mfResult.success) {
          errors.push(...mfResult.errors.map((e) => `Metafield: ${e}`));
        }
      }
    } catch (error) {
      errors.push(`Metafield sync error: ${(error as Error).message}`);
    }
  }

  // Sync images if enabled
  if (rule.syncImages) {
    try {
      const imgResult = await syncProductImages(sourceProductGid, destProductGid, sourceClient, destClient);
      if (!imgResult.success) {
        errors.push(...imgResult.errors.map((e) => `Image: ${e}`));
      }
    } catch (error) {
      errors.push(`Image sync error: ${(error as Error).message}`);
    }
  }

  // Sync inventory if enabled
  if (rule.syncInventory) {
    try {
      const invResults = await syncProductInventory(rule, sourceProductGid, sourceClient, destClient);
      for (const inv of invResults) {
        if (!inv.success && inv.error) {
          errors.push(`Inventory: ${inv.error}`);
        }
      }
    } catch (error) {
      errors.push(`Inventory sync error: ${(error as Error).message}`);
    }
  }

  return errors;
}
