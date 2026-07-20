import type { SyncRule, ConnectedStore, PriceRule } from "@prisma/client";
import prisma from "../db.server";
import { createClientForStore, ShopifyGraphQLClient } from "./shopify-client.server";
import { syncProduct, deleteProductOnDestination } from "./product-sync.server";
import { syncCollection, deleteCollectionOnDestination } from "./collection-sync.server";
import { syncInventoryItem } from "./inventory-sync.server";
import { syncProductExtras } from "./product-extras.server";

type SyncRuleWithRelations = SyncRule & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
  priceRule: PriceRule | null;
};

/**
 * Handle a product webhook (create/update/delete) from the source store
 */
export async function handleProductWebhook(
  topic: string,
  shopDomain: string,
  productGid: string
): Promise<void> {
  // Find all active sync rules where this shop is the source
  const syncRules = await prisma.syncRule.findMany({
    where: {
      sourceStore: { shopDomain },
      isActive: true,
      syncProducts: true,
      syncMode: { in: ["REALTIME", "REALTIME_AND_SCHEDULED"] },
    },
    include: {
      sourceStore: true,
      destStore: true,
      priceRule: true,
    },
  });

  if (!syncRules.length) return;

  for (const rule of syncRules) {
    // Check if product matches filters
    const matches = await matchesFilter(rule, productGid);
    if (!matches) continue;

    try {
      const sourceClient = await createClientForStore(rule.sourceStoreId);
      const destClient = await createClientForStore(rule.destStoreId);

      let result;

      if (topic.includes("delete")) {
        result = await deleteProductOnDestination(
          rule as SyncRuleWithRelations,
          productGid,
          destClient
        );
      } else {
        result = await syncProduct(
          rule as SyncRuleWithRelations,
          productGid,
          sourceClient,
          destClient
        );

        // Sync extras (metafields, images, inventory) after successful product sync
        if (result.success && result.destGid) {
          const extraErrors = await syncProductExtras(
            rule as SyncRuleWithRelations,
            productGid,
            result.destGid,
            sourceClient,
            destClient
          );
          if (extraErrors.length > 0) {
            console.warn(`[SyncEngine] Extras warnings for ${productGid}:`, extraErrors);
          }
        }
      }

      // Log the result
      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: result.action,
          resourceType: "PRODUCT",
          sourceGid: result.sourceGid,
          destGid: result.destGid,
          status: result.success ? "SUCCESS" : "FAILED",
          trigger: "WEBHOOK",
          message: result.success
            ? `Product ${result.action.toLowerCase()} successfully`
            : undefined,
          errorDetail: result.error,
          duration: result.duration,
        },
      });

      // Update store lastSyncAt
      await prisma.connectedStore.update({
        where: { id: rule.sourceStoreId },
        data: { lastSyncAt: new Date() },
      });
    } catch (error) {
      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: "SKIP",
          resourceType: "PRODUCT",
          sourceGid: productGid,
          status: "FAILED",
          trigger: "WEBHOOK",
          errorDetail: (error as Error).message,
        },
      });
    }
  }
}

/**
 * Handle a collection webhook from the source store
 */
export async function handleCollectionWebhook(
  topic: string,
  shopDomain: string,
  collectionGid: string
): Promise<void> {
  const syncRules = await prisma.syncRule.findMany({
    where: {
      sourceStore: { shopDomain },
      isActive: true,
      syncCollections: true,
      syncMode: { in: ["REALTIME", "REALTIME_AND_SCHEDULED"] },
    },
    include: {
      sourceStore: true,
      destStore: true,
      priceRule: true,
    },
  });

  if (!syncRules.length) return;

  for (const rule of syncRules) {
    try {
      const sourceClient = await createClientForStore(rule.sourceStoreId);
      const destClient = await createClientForStore(rule.destStoreId);

      let result;

      if (topic.includes("delete")) {
        result = await deleteCollectionOnDestination(
          rule as SyncRuleWithRelations,
          collectionGid,
          destClient
        );
      } else {
        result = await syncCollection(
          rule as SyncRuleWithRelations,
          collectionGid,
          sourceClient,
          destClient
        );
      }

      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: result.action,
          resourceType: "COLLECTION",
          sourceGid: result.sourceGid,
          destGid: result.destGid,
          status: result.success ? "SUCCESS" : "FAILED",
          trigger: "WEBHOOK",
          message: result.success
            ? `Collection ${result.action.toLowerCase()} successfully`
            : undefined,
          errorDetail: result.error,
          duration: result.duration,
        },
      });
    } catch (error) {
      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: topic.includes("delete") ? "DELETE" : "UPDATE",
          resourceType: "COLLECTION",
          sourceGid: collectionGid,
          status: "FAILED",
          trigger: "WEBHOOK",
          errorDetail: (error as Error).message,
        },
      });
    }
  }
}

/**
 * Handle inventory level update webhook
 */
export async function handleInventoryWebhook(
  shopDomain: string,
  inventoryItemId: string,
  locationId: string,
  available: number
): Promise<void> {
  const syncRules = await prisma.syncRule.findMany({
    where: {
      sourceStore: { shopDomain },
      isActive: true,
      syncInventory: true,
      syncMode: { in: ["REALTIME", "REALTIME_AND_SCHEDULED"] },
    },
    include: {
      sourceStore: true,
      destStore: true,
      priceRule: true,
    },
  });

  if (!syncRules.length) return;

  for (const rule of syncRules) {
    try {
      const destClient = await createClientForStore(rule.destStoreId);

      const result = await syncInventoryItem(
        rule as SyncRuleWithRelations,
        inventoryItemId,
        available,
        destClient
      );

      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: result.action,
          resourceType: "INVENTORY",
          sourceGid: result.sourceGid,
          status: result.success ? "SUCCESS" : "FAILED",
          trigger: "WEBHOOK",
          message: result.success
            ? `Inventory ${result.action.toLowerCase()} successfully`
            : undefined,
          errorDetail: result.error,
          duration: result.duration,
        },
      });
    } catch (error) {
      await prisma.syncLog.create({
        data: {
          syncRuleId: rule.id,
          storeId: rule.destStoreId,
          action: "UPDATE",
          resourceType: "INVENTORY",
          sourceGid: inventoryItemId,
          status: "FAILED",
          trigger: "WEBHOOK",
          errorDetail: (error as Error).message,
        },
      });
    }
  }
}

// Concurrency: how many products to sync in parallel.
// Shopify rate limit = 1000 points, restore 50/sec. Each product uses ~10-20 points.
// 3 concurrent keeps us safely under the limit.
const SYNC_CONCURRENCY = 3;

/**
 * Process an array of items in batches with concurrency limit.
 */
async function processBatch<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(handler));
  }
}

/**
 * Trigger a manual sync for a specific sync rule.
 * Returns immediately with a jobId — the sync runs in the background.
 */
export async function triggerManualSync(
  syncRuleId: string,
  productGids?: string[],
  currentSession?: { shop: string; accessToken: string }
): Promise<{ jobId: string; queued: number; errors: string[] }> {
  const rule = await prisma.syncRule.findUnique({
    where: { id: syncRuleId },
    include: { sourceStore: true, destStore: true, priceRule: true },
  });

  if (!rule) throw new Error("Sync rule not found");
  if (!rule.isActive) throw new Error("Sync rule is not active");

  console.log(`[SyncEngine] Manual sync started for rule ${syncRuleId}, filterType=${rule.filterType}, source=${rule.sourceStore.shopDomain}, dest=${rule.destStore.shopDomain}`);

  // Use the current authenticated session token directly if it matches source or dest store
  let sourceClient: ShopifyGraphQLClient;
  let destClient: ShopifyGraphQLClient;

  if (currentSession?.accessToken && currentSession.shop === rule.sourceStore.shopDomain) {
    console.log(`[SyncEngine] Using direct session token for source store ${currentSession.shop}`);
    sourceClient = new ShopifyGraphQLClient(currentSession.shop, currentSession.accessToken);
  } else {
    sourceClient = await createClientForStore(rule.sourceStoreId);
  }

  if (currentSession?.accessToken && currentSession.shop === rule.destStore.shopDomain) {
    console.log(`[SyncEngine] Using direct session token for dest store ${currentSession.shop}`);
    destClient = new ShopifyGraphQLClient(currentSession.shop, currentSession.accessToken);
  } else {
    destClient = await createClientForStore(rule.destStoreId);
  }

  // Resolve product list before going async
  let allProductGids: string[];
  if (productGids?.length) {
    allProductGids = productGids;
  } else {
    allProductGids = await fetchFilteredProducts(rule, sourceClient);
  }

  console.log(`[SyncEngine] Total products to sync: ${allProductGids.length}`);

  // Create a SyncJob to track progress
  const job = await prisma.syncJob.create({
    data: {
      syncRuleId: rule.id,
      totalProducts: allProductGids.length,
      trigger: "MANUAL",
    },
  });

  // If no products, mark job complete immediately
  if (allProductGids.length === 0) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return { jobId: job.id, queued: 0, errors: [] };
  }

  // Run the sync in the background so the HTTP request returns immediately
  const syncErrors: string[] = [];
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  const runBackground = async () => {
    try {
      await processBatch(allProductGids, SYNC_CONCURRENCY, async (gid) => {
        const result = await syncProduct(
          rule as SyncRuleWithRelations,
          gid,
          sourceClient,
          destClient,
          true // forceSync - manual sync always forces re-sync
        );

        // Sync extras after successful product sync
        if (result.success && result.destGid) {
          const extraErrors = await syncProductExtras(
            rule as SyncRuleWithRelations,
            gid,
            result.destGid,
            sourceClient,
            destClient
          );
          if (extraErrors.length > 0) {
            console.warn(`[SyncEngine] Extras warnings for ${gid}:`, extraErrors);
          }
        }

        await prisma.syncLog.create({
          data: {
            syncRuleId: rule.id,
            storeId: rule.destStoreId,
            action: result.action,
            resourceType: "PRODUCT",
            sourceGid: result.sourceGid,
            destGid: result.destGid,
            status: result.success ? "SUCCESS" : "FAILED",
            trigger: "MANUAL",
            errorDetail: result.error,
            duration: result.duration,
          },
        });

        if (result.success) {
          if (result.action === "SKIP") skipped++;
          else synced++;
        } else {
          failed++;
          if (result.error) syncErrors.push(result.error);
        }

        // Update job progress periodically (every product for small sets, or we could batch this)
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            syncedProducts: synced,
            failedProducts: failed,
            skippedProducts: skipped,
          },
        });
      });

      // Mark job complete
      const finalStatus = failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          syncedProducts: synced,
          failedProducts: failed,
          skippedProducts: skipped,
          errors: syncErrors.length > 0 ? JSON.stringify(syncErrors.slice(0, 50)) : null,
          completedAt: new Date(),
        },
      });

      console.log(`[SyncEngine] Job ${job.id} completed: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    } catch (error) {
      console.error(`[SyncEngine] Job ${job.id} FAILED:`, error);
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errors: JSON.stringify([...(syncErrors.slice(0, 49)), (error as Error).message]),
          completedAt: new Date(),
        },
      });
    }

    // Update lastRunAt
    await prisma.syncRule.update({
      where: { id: syncRuleId },
      data: { lastRunAt: new Date() },
    });

    await prisma.connectedStore.update({
      where: { id: rule.sourceStoreId },
      data: { lastSyncAt: new Date() },
    });
  };

  // Fire and forget — the job runs in the background
  runBackground().catch((err) => console.error(`[SyncEngine] Background sync fatal:`, err));

  return { jobId: job.id, queued: allProductGids.length, errors: [] };
}

/**
 * Get the current status of a sync job
 */
export async function getSyncJobStatus(jobId: string) {
  return prisma.syncJob.findUnique({ where: { id: jobId } });
}

/**
 * Check if a product matches the sync rule's filters
 */
async function matchesFilter(
  rule: SyncRule,
  productGid: string
): Promise<boolean> {
  switch (rule.filterType) {
    case "ALL":
      return true;

    case "SELECTED_PRODUCTS": {
      if (!rule.filterProductIds) return false;
      const ids: string[] = JSON.parse(rule.filterProductIds);
      return ids.includes(productGid);
    }

    case "SELECTED_COLLECTIONS": {
      if (!rule.filterCollectionIds) return false;
      // Check if product belongs to any of the selected collections
      // This requires querying the store, so for webhooks we'll be permissive
      // and check during actual sync
      return true;
    }

    case "BY_TAGS": {
      // Tag matching requires product data, checked during sync
      return true;
    }

    default:
      return true;
  }
}

/**
 * Fetch product GIDs that match the sync rule's filters
 */
async function fetchFilteredProducts(
  rule: SyncRule & { sourceStore: ConnectedStore },
  sourceClient: any
): Promise<string[]> {
  // For SELECTED_PRODUCTS, return the stored product GIDs directly
  if (rule.filterType === "SELECTED_PRODUCTS") {
    if (rule.filterProductIds) {
      try {
        const ids: string[] = JSON.parse(rule.filterProductIds);
        if (ids.length > 0) {
          console.log(`[SyncEngine] SELECTED_PRODUCTS: ${ids.length} products selected`);
          return ids;
        }
      } catch (e) {
        console.error(`[SyncEngine] Failed to parse filterProductIds:`, e);
      }
    }
    // Fallback: no products selected yet, sync ALL products from source
    console.log(`[SyncEngine] SELECTED_PRODUCTS filter but no filterProductIds set, falling back to ALL products`);
  }

  // For SELECTED_COLLECTIONS, fetch products from those collections
  if (rule.filterType === "SELECTED_COLLECTIONS" && rule.filterCollectionIds) {
    let collectionIds: string[] = [];
    try {
      collectionIds = JSON.parse(rule.filterCollectionIds);
    } catch (e) {
      console.error(`[SyncEngine] Failed to parse filterCollectionIds:`, e);
    }

    if (collectionIds.length > 0) {
      const productGids: string[] = [];
      const seen = new Set<string>();

      for (const collectionGid of collectionIds) {
        let hasNext = true;
        let cursor: string | null = null;

        while (hasNext) {
          const result: any = await sourceClient.queryWithRetry(
            `#graphql
            query GetCollectionProducts($id: ID!, $first: Int!, $after: String) {
              collection(id: $id) {
                products(first: 50, after: $after) {
                  edges {
                    node { id }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }`,
            { id: collectionGid, first: 50, after: cursor }
          );

          const products = result.data?.collection?.products;
          if (!products) break;

          for (const edge of products.edges) {
            if (!seen.has(edge.node.id)) {
              seen.add(edge.node.id);
              productGids.push(edge.node.id);
            }
          }

          hasNext = products.pageInfo.hasNextPage;
          cursor = products.pageInfo.endCursor;
        }
      }

      console.log(`[SyncEngine] SELECTED_COLLECTIONS: ${productGids.length} products from ${collectionIds.length} collections`);
      return productGids;
    }
    console.log(`[SyncEngine] SELECTED_COLLECTIONS filter but no collections set, falling back to ALL products`);
  }

  // For ALL or BY_TAGS, paginate through all products
  const productGids: string[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await sourceClient.queryWithRetry(
      `#graphql
      query GetProducts($after: String) {
        products(first: 50, after: $after) {
          edges {
            node {
              id
              tags
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after: cursor }
    );

    const products: any = result.data?.products;
    if (!products) {
      console.log(`[SyncEngine] No products data in API response`, JSON.stringify(result.errors || 'no errors'));
      break;
    }

    for (const edge of products.edges) {
      const product = edge.node;

      if (rule.filterType === "BY_TAGS" && rule.filterTags) {
        const filterTags = rule.filterTags.split(",").map((t: string) => t.trim().toLowerCase());
        const productTags = (product.tags || []).map((t: string) => t.toLowerCase());
        if (!filterTags.some((ft: string) => productTags.includes(ft))) {
          continue;
        }
      }

      productGids.push(product.id);
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  console.log(`[SyncEngine] Filter ${rule.filterType}: found ${productGids.length} products`);
  return productGids;
}
