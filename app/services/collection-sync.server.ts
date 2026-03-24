import type { SyncRule, ConnectedStore, PriceRule } from "@prisma/client";
import prisma from "../db.server";
import { ShopifyGraphQLClient, createClientForStore } from "./shopify-client.server";
import { GET_COLLECTIONS, GET_COLLECTION_PRODUCTS } from "../graphql/queries";
import {
  COLLECTION_CREATE_MUTATION,
  COLLECTION_UPDATE_MUTATION,
  COLLECTION_ADD_PRODUCTS_MUTATION,
  COLLECTION_DELETE_MUTATION,
} from "../graphql/mutations";

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

    // Sync collection products (for custom/manual collections without ruleSet)
    if (!sourceCollection.ruleSet) {
      await syncCollectionProducts(
        syncRule,
        sourceCollectionGid,
        destCollectionGid,
        sourceClient,
        destClient
      );
    }

    // Update mapping
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
        sourceCollectionGid,
        destCollectionGid,
        sourceHandle: sourceCollection.handle,
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
 * Sync products within a custom collection
 */
async function syncCollectionProducts(
  syncRule: SyncRuleWithRelations,
  sourceCollectionGid: string,
  destCollectionGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<void> {
  // Fetch all product IDs in the source collection
  const sourceProductGids: string[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await sourceClient.queryWithRetry(
      GET_COLLECTION_PRODUCTS,
      { id: sourceCollectionGid, first: 100, after: cursor }
    );

    const products = result.data?.collection?.products;
    if (!products) break;

    for (const edge of products.edges) {
      sourceProductGids.push(edge.node.id);
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  if (!sourceProductGids.length) return;

  // Map source product GIDs to destination product GIDs
  const mappings = await prisma.productMapping.findMany({
    where: {
      sourceStoreId: syncRule.sourceStoreId,
      destStoreId: syncRule.destStoreId,
      sourceProductGid: { in: sourceProductGids },
      status: "SYNCED",
      destProductGid: { not: null },
    },
  });

  const destProductIds = mappings
    .map((m) => m.destProductGid)
    .filter((id): id is string => id !== null);

  if (!destProductIds.length) return;

  // Add products to destination collection in batches of 250
  for (let i = 0; i < destProductIds.length; i += 250) {
    const batch = destProductIds.slice(i, i + 250);
    await destClient.queryWithRetry(COLLECTION_ADD_PRODUCTS_MUTATION, {
      id: destCollectionGid,
      productIds: batch,
    });
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
