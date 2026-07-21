import type { SyncRule, ConnectedStore, PriceRule, MissingProductAction } from "@prisma/client";
import prisma from "../db.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import { createClientForStore } from "./shopify-client.server";
import {
  GET_COLLECTIONS,
  GET_COLLECTION_PRODUCTS,
  GET_JOB_STATUS,
} from "../graphql/queries";
import {
  COLLECTION_CREATE_MUTATION,
  COLLECTION_UPDATE_MUTATION,
  COLLECTION_ADD_PRODUCTS_MUTATION,
  COLLECTION_REMOVE_PRODUCTS_MUTATION,
  COLLECTION_REORDER_PRODUCTS_MUTATION,
  COLLECTION_DELETE_MUTATION,
} from "../graphql/mutations";
import { syncProduct } from "./product-sync.server";
import { syncProductExtras } from "./product-extras.server";

type SyncRuleWithRelations = SyncRule & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
  priceRule: PriceRule | null;
};

interface SyncCollectionResult {
  success: boolean;
  action: "CREATE" | "UPDATE" | "DELETE" | "SKIP";
  sourceGid: string;
  destGid?: string;
  error?: string;
  duration: number;
}

/**
 * Sync a single collection from source to destination
 */
export async function syncCollection(
  syncRule: SyncRuleWithRelations,
  sourceCollectionGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncCollectionResult> {
  const startTime = Date.now();

  try {
    // Fetch collection data from source
    const sourceResult = await sourceClient.queryWithRetry(
      `#graphql
      query GetCollection($id: ID!) {
        collection(id: $id) {
          id
          title
          handle
          descriptionHtml
          sortOrder
          templateSuffix
          image {
            url
            altText
          }
          seo {
            title
            description
          }
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
        }
      }`,
      { id: sourceCollectionGid }
    );

    if (sourceResult.errors?.length || !sourceResult.data?.collection) {
      return {
        success: false,
        action: "SKIP",
        sourceGid: sourceCollectionGid,
        error: sourceResult.errors?.[0]?.message || "Collection not found",
        duration: Date.now() - startTime,
      };
    }

    const sourceCollection = sourceResult.data.collection;

    // Check existing mapping
    const existingMapping = await prisma.collectionMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceCollectionGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceCollectionGid,
        },
      },
    });

    const isNew = !existingMapping?.destCollectionGid;

    // Build collection input
    const collectionInput: any = {
      title: existingMapping?.destTitle || sourceCollection.title,
      descriptionHtml: sourceCollection.descriptionHtml,
      seo: sourceCollection.seo,
    };

    // Sync the ordering mode (MANUAL, BEST_SELLING, ALPHA_ASC, PRICE_DESC, ...)
    // so the destination collection orders products the same way as the source.
    if (sourceCollection.sortOrder) {
      collectionInput.sortOrder = sourceCollection.sortOrder;
    }

    if (sourceCollection.templateSuffix != null) {
      collectionInput.templateSuffix = sourceCollection.templateSuffix;
    }

    // Sync the collection hero image when present.
    if (sourceCollection.image?.url) {
      collectionInput.image = {
        src: sourceCollection.image.url,
        altText: sourceCollection.image.altText ?? undefined,
      };
    }

    // If smart collection, include rules
    if (sourceCollection.ruleSet) {
      collectionInput.ruleSet = {
        appliedDisjunctively: sourceCollection.ruleSet.appliedDisjunctively,
        rules: sourceCollection.ruleSet.rules.map((r: any) => ({
          column: r.column,
          relation: r.relation,
          condition: r.condition,
        })),
      };
    }

    let destCollectionGid: string;

    if (isNew) {
      // Create new collection on destination
      const createResult = await destClient.queryWithRetry(
        COLLECTION_CREATE_MUTATION,
        { input: collectionInput }
      );

      if (createResult.data?.collectionCreate?.userErrors?.length) {
        return {
          success: false,
          action: "CREATE",
          sourceGid: sourceCollectionGid,
          error: createResult.data.collectionCreate.userErrors[0].message,
          duration: Date.now() - startTime,
        };
      }

      destCollectionGid = createResult.data?.collectionCreate?.collection?.id;
      if (!destCollectionGid) {
        return {
          success: false,
          action: "CREATE",
          sourceGid: sourceCollectionGid,
          error: "No collection returned from create",
          duration: Date.now() - startTime,
        };
      }
    } else {
      // Update existing collection
      collectionInput.id = existingMapping!.destCollectionGid;
      destCollectionGid = existingMapping!.destCollectionGid!;

      const updateResult = await destClient.queryWithRetry(
        COLLECTION_UPDATE_MUTATION,
        { input: collectionInput }
      );

      if (updateResult.data?.collectionUpdate?.userErrors?.length) {
        return {
          success: false,
          action: "UPDATE",
          sourceGid: sourceCollectionGid,
          error: updateResult.data.collectionUpdate.userErrors[0].message,
          duration: Date.now() - startTime,
        };
      }
    }

    // Sync collection products (for custom/manual collections without ruleSet).
    // Smart collections populate themselves from their ruleSet on the destination,
    // so we only manage membership/order for manual collections.
    if (!sourceCollection.ruleSet) {
      await syncCollectionProducts(
        syncRule,
        sourceCollectionGid,
        destCollectionGid,
        sourceCollection.sortOrder,
        existingMapping?.missingProductAction || "SKIP",
        sourceClient,
        destClient
      );
    }

    // Update mapping. Only set syncRuleId on first creation (a manually-created
    // mapping may already point at a different rule than the one that happens
    // to be syncing right now) and never overwrite the user's chosen
    // missingProductAction here.
    await prisma.collectionMapping.upsert({
      where: {
        sourceStoreId_destStoreId_sourceCollectionGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceCollectionGid,
        },
      },
      update: {
        destCollectionGid,
        status: "SYNCED",
        lastSyncedAt: new Date(),
      },
      create: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        destCollectionGid,
        sourceCollectionGid,
        sourceHandle: sourceCollection.handle,
        syncRuleId: syncRule.id,
        status: "SYNCED",
        lastSyncedAt: new Date(),
      },
    });

    return {
      success: true,
      action: isNew ? "CREATE" : "UPDATE",
      sourceGid: sourceCollectionGid,
      destGid: destCollectionGid,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "SKIP",
      sourceGid: sourceCollectionGid,
      error: (error as Error).message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Sync products within a custom (manual) collection, preserving the source
 * collection's product membership AND order.
 *
 * - Products are added/removed so the destination membership matches the source.
 * - Drift cleanup only removes products this app manages (i.e. products that map
 *   back to a source product), so manually-curated destination products are left
 *   untouched.
 * - When the source uses MANUAL sort order, the destination products are reordered
 *   to match the exact source order via collectionReorderProducts.
 */
async function syncCollectionProducts(
  syncRule: SyncRuleWithRelations,
  sourceCollectionGid: string,
  destCollectionGid: string,
  sortOrder: string | null | undefined,
  missingProductAction: MissingProductAction,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<void> {
  // Fetch all product IDs in the source collection, in collection order.
  const sourceProductGids = await fetchCollectionProductGids(
    sourceClient,
    sourceCollectionGid
  );

  // Map source product GIDs -> destination product GIDs (only synced products).
  const mappings = await prisma.productMapping.findMany({
    where: {
      sourceStoreId: syncRule.sourceStoreId,
      destStoreId: syncRule.destStoreId,
      status: "SYNCED",
      destProductGid: { not: null },
    },
    select: { sourceProductGid: true, destProductGid: true },
  });

  const sourceToDest = new Map<string, string>();
  const managedDestIds = new Set<string>();
  for (const m of mappings) {
    if (m.destProductGid) {
      sourceToDest.set(m.sourceProductGid, m.destProductGid);
      managedDestIds.add(m.destProductGid);
    }
  }

  // Products in the source collection with no destination mapping yet.
  // Skip them (default), create them on the destination now, or link an
  // already-existing destination product by handle without touching it.
  if (missingProductAction === "CREATE") {
    for (const sourceGid of sourceProductGids) {
      if (sourceToDest.has(sourceGid)) continue;

      const result = await syncProduct(syncRule, sourceGid, sourceClient, destClient);

      if (result.success && result.destGid) {
        sourceToDest.set(sourceGid, result.destGid);
        managedDestIds.add(result.destGid);

        const extraErrors = await syncProductExtras(
          syncRule,
          sourceGid,
          result.destGid,
          sourceClient,
          destClient
        );
        if (extraErrors.length > 0) {
          console.warn(`[CollectionSync] Extras warnings for ${sourceGid}:`, extraErrors);
        }
      }

      await prisma.syncLog.create({
        data: {
          syncRuleId: syncRule.id,
          storeId: syncRule.destStoreId,
          action: result.action,
          resourceType: "PRODUCT",
          sourceGid: result.sourceGid,
          destGid: result.destGid,
          status: result.success ? "SUCCESS" : "FAILED",
          trigger: "MANUAL",
          message: result.success
            ? `Product ${result.action.toLowerCase()} while syncing collection`
            : undefined,
          errorDetail: result.error,
          duration: result.duration,
        },
      });
    }
  } else if (missingProductAction === "LINK_EXISTING") {
    for (const sourceGid of sourceProductGids) {
      if (sourceToDest.has(sourceGid)) continue;

      const linkResult = await linkExistingProductByHandle(
        syncRule,
        sourceGid,
        sourceClient,
        destClient
      );

      if (linkResult.success && linkResult.linked && linkResult.destGid) {
        sourceToDest.set(sourceGid, linkResult.destGid);
        managedDestIds.add(linkResult.destGid);
      }

      await prisma.syncLog.create({
        data: {
          syncRuleId: syncRule.id,
          storeId: syncRule.destStoreId,
          action: linkResult.linked ? "CREATE" : "SKIP",
          resourceType: "PRODUCT",
          sourceGid,
          destGid: linkResult.destGid,
          status: linkResult.success ? "SUCCESS" : "FAILED",
          trigger: "MANUAL",
          message: linkResult.success
            ? linkResult.linked
              ? "Linked to existing destination product by handle — no fields changed"
              : "No destination product with matching handle — skipped"
            : undefined,
          errorDetail: linkResult.error,
        },
      });
    }
  }

  // Desired destination products, in the SAME order as the source collection.
  const desiredDestIds: string[] = [];
  const seen = new Set<string>();
  for (const sourceGid of sourceProductGids) {
    const destGid = sourceToDest.get(sourceGid);
    if (destGid && !seen.has(destGid)) {
      desiredDestIds.push(destGid);
      seen.add(destGid);
    }
  }

  const desiredSet = new Set(desiredDestIds);

  // Current products already in the destination collection.
  const currentDestIds = await fetchCollectionProductGids(
    destClient,
    destCollectionGid
  );
  const currentSet = new Set(currentDestIds);

  // Products to add: desired but not currently present.
  const toAdd = desiredDestIds.filter((id) => !currentSet.has(id));

  // Products to remove: currently present, managed by this app, but no longer
  // desired. We never remove products the app doesn't manage.
  const toRemove = currentDestIds.filter(
    (id) => managedDestIds.has(id) && !desiredSet.has(id)
  );

  // Apply adds in batches of 250.
  for (let i = 0; i < toAdd.length; i += 250) {
    const batch = toAdd.slice(i, i + 250);
    const res: any = await destClient.queryWithRetry(
      COLLECTION_ADD_PRODUCTS_MUTATION,
      { id: destCollectionGid, productIds: batch }
    );
    const jobId = res.data?.collectionAddProductsV2?.job?.id;
    await waitForJob(destClient, jobId);
  }

  // Apply removals in batches of 250.
  for (let i = 0; i < toRemove.length; i += 250) {
    const batch = toRemove.slice(i, i + 250);
    const res: any = await destClient.queryWithRetry(
      COLLECTION_REMOVE_PRODUCTS_MUTATION,
      { id: destCollectionGid, productIds: batch }
    );
    const jobId = res.data?.collectionRemoveProducts?.job?.id;
    await waitForJob(destClient, jobId);
  }

  // Preserve the exact manual order. Reorder is only meaningful (and only
  // permitted) when the collection uses MANUAL sort order.
  if (sortOrder === "MANUAL" && desiredDestIds.length) {
    const moves = desiredDestIds.map((id, index) => ({
      id,
      newPosition: String(index),
    }));

    for (let i = 0; i < moves.length; i += 250) {
      const batch = moves.slice(i, i + 250);
      const res: any = await destClient.queryWithRetry(
        COLLECTION_REORDER_PRODUCTS_MUTATION,
        { id: destCollectionGid, moves: batch }
      );
      const jobId = res.data?.collectionReorderProducts?.job?.id;
      await waitForJob(destClient, jobId);
    }
  }
}

interface LinkExistingProductResult {
  success: boolean;
  linked: boolean;
  destGid?: string;
  error?: string;
}

/**
 * Link a source product to an already-existing destination product with the
 * same handle, without ever pushing field updates to it — used when
 * missingProductAction is LINK_EXISTING. Only records the ProductMapping
 * (and variant mappings, matched by SKU) so the collection sync can add it
 * to the destination collection.
 */
async function linkExistingProductByHandle(
  syncRule: SyncRuleWithRelations,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<LinkExistingProductResult> {
  const sourceResult = await sourceClient.queryWithRetry(
    `#graphql
    query GetProductForLink($id: ID!) {
      product(id: $id) {
        id
        handle
        variants(first: 100) {
          edges { node { id sku } }
        }
      }
    }`,
    { id: sourceProductGid }
  );

  const sourceProduct = sourceResult.data?.product;
  if (!sourceProduct) {
    return {
      success: false,
      linked: false,
      error: sourceResult.errors?.[0]?.message || "Source product not found",
    };
  }

  const destResult = await destClient.queryWithRetry(
    `#graphql
    query GetProductByHandleForLink($handle: String!) {
      productByHandle(handle: $handle) {
        id
        variants(first: 100) {
          edges { node { id sku } }
        }
      }
    }`,
    { handle: sourceProduct.handle }
  );

  const destProduct = destResult.data?.productByHandle;
  if (!destProduct) {
    return { success: true, linked: false };
  }

  const variantMappings = matchVariantsBySku(
    sourceProduct.variants.edges.map((e: any) => e.node),
    destProduct.variants.edges.map((e: any) => e.node)
  );

  await prisma.productMapping.upsert({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceProductGid,
      },
    },
    update: {
      destProductGid: destProduct.id,
      variantMappings: JSON.stringify(variantMappings),
      status: "SYNCED",
      lastSyncedAt: new Date(),
    },
    create: {
      sourceStoreId: syncRule.sourceStoreId,
      destStoreId: syncRule.destStoreId,
      sourceProductGid,
      destProductGid: destProduct.id,
      sourceHandle: sourceProduct.handle,
      variantMappings: JSON.stringify(variantMappings),
      status: "SYNCED",
      lastSyncedAt: new Date(),
    },
  });

  return { success: true, linked: true, destGid: destProduct.id };
}

/**
 * Match source/destination variants by SKU first (since a linked product was
 * created independently, positions won't line up), falling back to position
 * for anything left unmatched.
 */
function matchVariantsBySku(
  sourceVariants: Array<{ id: string; sku: string | null }>,
  destVariants: Array<{ id: string; sku: string | null }>
): Array<{ sourceVariantGid: string; destVariantGid: string; sourceSku: string }> {
  const destBySku = new Map<string, string>();
  for (const dv of destVariants) {
    if (dv.sku) destBySku.set(dv.sku, dv.id);
  }

  const usedDestIds = new Set<string>();
  const result: Array<{ sourceVariantGid: string; destVariantGid: string; sourceSku: string }> = [];
  const unmatchedSource: typeof sourceVariants = [];

  for (const sv of sourceVariants) {
    const destId = sv.sku ? destBySku.get(sv.sku) : undefined;
    if (destId && !usedDestIds.has(destId)) {
      result.push({ sourceVariantGid: sv.id, destVariantGid: destId, sourceSku: sv.sku || "" });
      usedDestIds.add(destId);
    } else {
      unmatchedSource.push(sv);
    }
  }

  const unmatchedDest = destVariants.filter((dv) => !usedDestIds.has(dv.id));
  unmatchedSource.forEach((sv, i) => {
    result.push({
      sourceVariantGid: sv.id,
      destVariantGid: unmatchedDest[i]?.id || "",
      sourceSku: sv.sku || "",
    });
  });

  return result;
}

/**
 * Fetch all product GIDs in a collection, in the collection's current sort order.
 */
async function fetchCollectionProductGids(
  client: ShopifyGraphQLClient,
  collectionGid: string
): Promise<string[]> {
  const gids: string[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await client.queryWithRetry(GET_COLLECTION_PRODUCTS, {
      id: collectionGid,
      first: 100,
      after: cursor,
    });

    const products = result.data?.collection?.products;
    if (!products) break;

    for (const edge of products.edges) {
      gids.push(edge.node.id);
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  return gids;
}

/**
 * Poll an async Shopify Job until it completes (best-effort, bounded).
 * collectionReorderProducts requires the add/remove jobs to have finished, so
 * we wait before issuing dependent mutations.
 */
async function waitForJob(
  client: ShopifyGraphQLClient,
  jobId: string | undefined | null,
  maxAttempts = 20
): Promise<void> {
  if (!jobId) return;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result: any = await client.queryWithRetry(GET_JOB_STATUS, {
      id: jobId,
    });
    if (result.data?.job?.done) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500 * (attempt + 1), 3000))
    );
  }
}

/**
 * Delete a collection from destination store
 */
export async function deleteCollectionOnDestination(
  syncRule: SyncRuleWithRelations,
  sourceCollectionGid: string,
  destClient: ShopifyGraphQLClient
): Promise<SyncCollectionResult> {
  const startTime = Date.now();

  const mapping = await prisma.collectionMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceCollectionGid: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceCollectionGid,
      },
    },
  });

  if (!mapping?.destCollectionGid) {
    return {
      success: true,
      action: "SKIP",
      sourceGid: sourceCollectionGid,
      duration: Date.now() - startTime,
    };
  }

  try {
    await destClient.queryWithRetry(COLLECTION_DELETE_MUTATION, {
      input: { id: mapping.destCollectionGid },
    });

    await prisma.collectionMapping.delete({ where: { id: mapping.id } });

    return {
      success: true,
      action: "DELETE",
      sourceGid: sourceCollectionGid,
      destGid: mapping.destCollectionGid,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "DELETE",
      sourceGid: sourceCollectionGid,
      error: (error as Error).message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Fetch all collection GIDs from source store
 */
export async function fetchAllCollections(
  sourceClient: ShopifyGraphQLClient
): Promise<Array<{ id: string; title: string; handle: string }>> {
  const collections: Array<{ id: string; title: string; handle: string }> = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await sourceClient.queryWithRetry(GET_COLLECTIONS, {
      first: 50,
      after: cursor,
    });

    const data = result.data?.collections;
    if (!data) break;

    for (const edge of data.edges) {
      collections.push({
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
      });
    }

    hasNext = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return collections;
}

/**
 * Manually re-sync a single collection mapping right now (the "Sync now"
 * button on the Collection Mapping page), instead of waiting for the next
 * collections/update webhook. Fire-and-forget from the caller's perspective —
 * this can take a while for large collections (add/remove/reorder jobs are
 * polled to completion), so callers should not await this on a request that
 * needs to return quickly.
 */
export async function triggerManualCollectionSync(mappingId: string): Promise<void> {
  const mapping = await prisma.collectionMapping.findUnique({
    where: { id: mappingId },
    include: {
      syncRule: {
        include: { sourceStore: true, destStore: true, priceRule: true },
      },
    },
  });

  if (!mapping) throw new Error("Collection mapping not found");
  if (!mapping.syncRule) {
    throw new Error("This mapping has no linked sync rule — recreate it to enable manual sync");
  }
  if (!mapping.syncRule.isActive) {
    throw new Error("The linked sync rule is not active");
  }
  if (!mapping.syncRule.syncCollections) {
    throw new Error("Collections are turned off for this store connection");
  }

  const rule = mapping.syncRule as SyncRuleWithRelations;
  const sourceClient = await createClientForStore(rule.sourceStoreId);
  const destClient = await createClientForStore(rule.destStoreId);

  const result = await syncCollection(rule, mapping.sourceCollectionGid, sourceClient, destClient);

  await prisma.syncLog.create({
    data: {
      syncRuleId: rule.id,
      storeId: rule.destStoreId,
      action: result.action,
      resourceType: "COLLECTION",
      sourceGid: result.sourceGid,
      destGid: result.destGid,
      status: result.success ? "SUCCESS" : "FAILED",
      trigger: "MANUAL",
      message: result.success
        ? `Collection ${result.action.toLowerCase()} successfully`
        : undefined,
      errorDetail: result.error,
      duration: result.duration,
    },
  });
}
