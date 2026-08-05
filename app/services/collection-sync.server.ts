import type { CollectionMapping, ConnectedStore } from "@prisma/client";
import prisma from "../db.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import { createClientForStore } from "./shopify-client.server";
import {
  GET_COLLECTION_PRODUCTS,
  GET_JOB_STATUS,
} from "../graphql/queries";
import {
  COLLECTION_CREATE_MUTATION,
  COLLECTION_UPDATE_MUTATION,
  COLLECTION_UPDATE_DETAILS_MUTATION,
  COLLECTION_ADD_PRODUCTS_MUTATION,
  COLLECTION_REMOVE_PRODUCTS_MUTATION,
  COLLECTION_REORDER_PRODUCTS_MUTATION,
  COLLECTION_DELETE_MUTATION,
} from "../graphql/mutations";
import { syncProduct } from "./product-sync.server";
import type { SyncRuleWithRelations } from "./product-sync.server";
import { syncProductExtras } from "./product-extras.server";

/**
 * Collection Mapping is self-contained — it doesn't depend on the SyncRule
 * (full-catalog-sync) concept at all. A mapping always exists before
 * anything about it ever syncs (opt-in only, nothing auto-created), so the
 * engine operates directly on the mapping row instead of a SyncRule.
 */
type CollectionMappingWithStores = CollectionMapping & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
};

type SourceCollectionData = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  sortOrder: string | null;
  templateSuffix: string | null;
  image: { url: string; altText: string | null } | null;
  seo: { title: string | null; description: string | null } | null;
  ruleSet: {
    appliedDisjunctively: boolean;
    rules: Array<{ column: string; relation: string; condition: string }>;
  } | null;
};

type PublicCollectionData = {
  baseUrl: string;
  title: string;
  handle: string;
  productsCount: number | null;
};

interface SyncCollectionResult {
  success: boolean;
  action: "CREATE" | "UPDATE" | "DELETE" | "SKIP";
  sourceGid: string;
  destGid?: string;
  error?: string;
  duration: number;
}

type SyncRunError = {
  sourceGid: string;
  error: string;
};

type CollectionSyncRunStats = {
  jobId?: string;
  totalProducts: number;
  syncedProducts: number;
  failedProducts: number;
  skippedProducts: number;
  errors: SyncRunError[];
};

async function updateCollectionRunJob(stats: CollectionSyncRunStats) {
  if (!stats.jobId) return;

  try {
    await prisma.syncJob.update({
      where: { id: stats.jobId },
      data: {
        totalProducts: stats.totalProducts,
        syncedProducts: stats.syncedProducts,
        failedProducts: stats.failedProducts,
        skippedProducts: stats.skippedProducts,
        errors: stats.errors.length > 0 ? JSON.stringify(stats.errors.slice(0, 50)) : null,
      },
    });
  } catch (error) {
    console.warn(`[CollectionSync] Failed to update sync job ${stats.jobId}:`, error);
  }
}

const COLLECTION_FIELDS = `#graphql
  fragment CollectionFields on Collection {
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
`;

function legacyCollectionIdFromGid(collectionGid: string): string | null {
  return collectionGid.match(/gid:\/\/shopify\/Collection\/(\d+)/)?.[1] || null;
}

function shopifyEnum(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/-/g, "_").toUpperCase();
}

function mapRestRuleColumn(column: string): string {
  const normalized = shopifyEnum(column) || column;
  const aliases: Record<string, string> = {
    PRODUCT_TITLE: "TITLE",
    PRODUCT_TYPE: "TYPE",
    INVENTORY_STOCK: "VARIANT_INVENTORY",
  };
  return aliases[normalized] || normalized;
}

function mapRestRuleRelation(relation: string): string {
  const normalized = shopifyEnum(relation) || relation;
  const aliases: Record<string, string> = {
    EQUAL: "EQUALS",
    NOT_EQUAL: "NOT_EQUALS",
  };
  return aliases[normalized] || normalized;
}

function fallbackCollectionData(mapping: CollectionMappingWithStores): SourceCollectionData {
  const legacyId = legacyCollectionIdFromGid(mapping.sourceCollectionGid);
  return {
    id: mapping.sourceCollectionGid,
    title: mapping.destTitle || mapping.sourceHandle || (legacyId ? `Collection #${legacyId}` : "Imported collection"),
    handle: mapping.sourceHandle || "",
    descriptionHtml: null,
    sortOrder: "MANUAL",
    templateSuffix: null,
    image: null,
    seo: null,
    ruleSet: null,
  };
}

function normalizeText(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function slugifyHandle(value: string | null | undefined) {
  const slug = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "";
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function fetchPrimaryDomainUrl(
  sourceClient: ShopifyGraphQLClient,
  fallbackShopDomain: string
): Promise<string[]> {
  const urls: string[] = [];

  try {
    const result: any = await sourceClient.queryWithRetry(
      `#graphql
      query GetShopPrimaryDomain {
        shop {
          primaryDomain {
            url
          }
        }
      }`
    );
    const primaryUrl = result.data?.shop?.primaryDomain?.url;
    if (primaryUrl) urls.push(primaryUrl);
  } catch (error) {
    console.warn(
      `[CollectionSync] Could not fetch primary domain for ${fallbackShopDomain}:`,
      (error as Error).message
    );
  }

  urls.push(`https://${fallbackShopDomain}`);
  return uniqueStrings(urls).map((url) => url.replace(/\/+$/, ""));
}

async function fetchPublicJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DorecStoreSync/1.0",
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function findPublicCollectionData(
  mapping: CollectionMappingWithStores,
  sourceClient: ShopifyGraphQLClient,
  sourceTitle?: string | null
): Promise<PublicCollectionData | null> {
  const desiredTitles = uniqueStrings([
    sourceTitle,
    mapping.destTitle,
    mapping.sourceHandle,
  ]).map(normalizeText);
  const desiredHandles = uniqueStrings([
    mapping.sourceHandle,
    slugifyHandle(sourceTitle),
    slugifyHandle(mapping.destTitle),
  ]).map(normalizeText);

  if (!desiredTitles.length && !desiredHandles.length) return null;

  const baseUrls = await fetchPrimaryDomainUrl(
    sourceClient,
    mapping.sourceStore.shopDomain
  );

  for (const baseUrl of baseUrls) {
    for (let page = 1; page <= 10; page++) {
      const url = joinUrl(baseUrl, `/collections.json?limit=250&page=${page}`);
      const result = await fetchPublicJson<{
        collections?: Array<{
          title?: string;
          handle?: string;
          products_count?: number;
        }>;
      }>(url);
      const collections = result?.collections || [];
      if (!collections.length) break;

      const match = collections.find((collection) => {
        const title = normalizeText(collection.title);
        const handle = normalizeText(collection.handle);
        return (
          (title && desiredTitles.includes(title)) ||
          (handle && desiredHandles.includes(handle))
        );
      });

      if (match?.handle && match.title) {
        return {
          baseUrl,
          title: match.title,
          handle: match.handle,
          productsCount:
            typeof match.products_count === "number" ? match.products_count : null,
        };
      }
    }
  }

  return null;
}

async function fetchRestCollectionData(
  mapping: CollectionMappingWithStores,
  sourceClient: ShopifyGraphQLClient
): Promise<SourceCollectionData | null> {
  const legacyId = legacyCollectionIdFromGid(mapping.sourceCollectionGid);
  if (!legacyId) return null;

  try {
    const result = await sourceClient.rest<any>(`smart_collections/${legacyId}.json`);
    const collection = result?.smart_collection;
    if (collection) {
      console.warn(
        `[CollectionSync] Using REST smart_collection fallback for ${mapping.sourceCollectionGid} on ${mapping.sourceStore.shopDomain}`
      );
      return {
        id: mapping.sourceCollectionGid,
        title: collection.title || mapping.destTitle || `Collection #${legacyId}`,
        handle: collection.handle || mapping.sourceHandle || "",
        descriptionHtml: collection.body_html || null,
        sortOrder: shopifyEnum(collection.sort_order) || "MANUAL",
        templateSuffix: collection.template_suffix || null,
        image: collection.image?.src
          ? {
              url: collection.image.src,
              altText: collection.image.alt || null,
            }
          : null,
        seo: {
          title: collection.metafields_global_title_tag || null,
          description: collection.metafields_global_description_tag || null,
        },
        ruleSet: {
          appliedDisjunctively: !!collection.disjunctive,
          rules: (collection.rules || []).map((rule: any) => ({
            column: mapRestRuleColumn(rule.column),
            relation: mapRestRuleRelation(rule.relation),
            condition: String(rule.condition ?? ""),
          })),
        },
      };
    }
  } catch (error) {
    console.warn(
      `[CollectionSync] REST smart_collection lookup failed for ${mapping.sourceCollectionGid}:`,
      (error as Error).message
    );
  }

  try {
    const result = await sourceClient.rest<any>(`custom_collections/${legacyId}.json`);
    const collection = result?.custom_collection;
    if (collection) {
      console.warn(
        `[CollectionSync] Using REST custom_collection fallback for ${mapping.sourceCollectionGid} on ${mapping.sourceStore.shopDomain}`
      );
      return {
        id: mapping.sourceCollectionGid,
        title: collection.title || mapping.destTitle || `Collection #${legacyId}`,
        handle: collection.handle || mapping.sourceHandle || "",
        descriptionHtml: collection.body_html || null,
        sortOrder: shopifyEnum(collection.sort_order) || "MANUAL",
        templateSuffix: collection.template_suffix || null,
        image: collection.image?.src
          ? {
              url: collection.image.src,
              altText: collection.image.alt || null,
            }
          : null,
        seo: {
          title: collection.metafields_global_title_tag || null,
          description: collection.metafields_global_description_tag || null,
        },
        ruleSet: null,
      };
    }
  } catch (error) {
    console.warn(
      `[CollectionSync] REST custom_collection lookup failed for ${mapping.sourceCollectionGid}:`,
      (error as Error).message
    );
  }

  return null;
}

async function fetchSourceCollectionData(
  mapping: CollectionMappingWithStores,
  sourceClient: ShopifyGraphQLClient
): Promise<SourceCollectionData> {
  const lookupErrors: string[] = [];
  const byIdResult: any = await sourceClient.queryWithRetry(
    `${COLLECTION_FIELDS}
    query GetCollection($id: ID!) {
      collection(id: $id) {
        ...CollectionFields
      }
    }`,
    { id: mapping.sourceCollectionGid }
  );

  if (byIdResult.errors?.length) {
    lookupErrors.push(
      `id lookup: ${byIdResult.errors
        .map((error: { message: string }) => error.message)
        .join("; ")}`
    );
  }

  if (byIdResult.data?.collection) {
    return byIdResult.data.collection;
  }

  const byIdentifierIdResult: any = await sourceClient.queryWithRetry(
    `${COLLECTION_FIELDS}
    query GetCollectionByIdentifierId($identifier: CollectionIdentifierInput!) {
      collectionByIdentifier(identifier: $identifier) {
        ...CollectionFields
      }
    }`,
    { identifier: { id: mapping.sourceCollectionGid } }
  );

  if (byIdentifierIdResult.data?.collectionByIdentifier) {
    console.warn(
      `[CollectionSync] Collection ${mapping.sourceCollectionGid} was not visible via collection(id:) on ${mapping.sourceStore.shopDomain}; using collectionByIdentifier(id)`
    );
    return byIdentifierIdResult.data.collectionByIdentifier;
  }

  if (byIdentifierIdResult.errors?.length) {
    lookupErrors.push(
      `identifier id lookup: ${byIdentifierIdResult.errors
        .map((error: { message: string }) => error.message)
        .join("; ")}`
    );
  }

  if (mapping.sourceHandle) {
    const byIdentifierResult: any = await sourceClient.queryWithRetry(
      `${COLLECTION_FIELDS}
      query GetCollectionByIdentifier($identifier: CollectionIdentifierInput!) {
        collectionByIdentifier(identifier: $identifier) {
          ...CollectionFields
        }
      }`,
      { identifier: { handle: mapping.sourceHandle } }
    );

    if (byIdentifierResult.data?.collectionByIdentifier) {
      console.warn(
        `[CollectionSync] Collection ${mapping.sourceCollectionGid} was not visible via collection(id:) on ${mapping.sourceStore.shopDomain}; using collectionByIdentifier(handle: "${mapping.sourceHandle}")`
      );
      return byIdentifierResult.data.collectionByIdentifier;
    }

    if (byIdentifierResult.errors?.length) {
      lookupErrors.push(
        `identifier handle lookup: ${byIdentifierResult.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`
      );
    }

    const byHandleResult: any = await sourceClient.queryWithRetry(
      `${COLLECTION_FIELDS}
      query GetCollectionByHandle($handle: String!) {
        collectionByHandle(handle: $handle) {
          ...CollectionFields
        }
      }`,
      { handle: mapping.sourceHandle }
    );

    if (byHandleResult.data?.collectionByHandle) {
      console.warn(
        `[CollectionSync] Collection ${mapping.sourceCollectionGid} was not visible via collection(id:) on ${mapping.sourceStore.shopDomain}; using collectionByHandle("${mapping.sourceHandle}")`
      );
      return byHandleResult.data.collectionByHandle;
    }

    if (byHandleResult.errors?.length) {
      lookupErrors.push(
        `handle lookup: ${byHandleResult.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`
      );
    }
  }

  const fallbackQueries = [
    mapping.sourceHandle ? `handle:${mapping.sourceHandle}` : null,
    legacyCollectionIdFromGid(mapping.sourceCollectionGid)
      ? `id:${legacyCollectionIdFromGid(mapping.sourceCollectionGid)}`
      : null,
  ].filter(Boolean) as string[];

  for (const query of fallbackQueries) {
    const bySearchResult: any = await sourceClient.queryWithRetry(
      `${COLLECTION_FIELDS}
      query FindCollection($query: String!) {
        collections(first: 1, query: $query) {
          edges {
            node {
              ...CollectionFields
            }
          }
        }
      }`,
      { query }
    );

    if (bySearchResult.errors?.length) {
      lookupErrors.push(
        `collections search "${query}": ${bySearchResult.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`
      );
      continue;
    }

    const collection = bySearchResult.data?.collections?.edges?.[0]?.node;
    if (collection) {
      console.warn(
        `[CollectionSync] Collection ${mapping.sourceCollectionGid} was not visible via collection(id:) on ${mapping.sourceStore.shopDomain}; using collections search "${query}"`
      );
      return collection;
    }
  }

  const lookupDetails = [
    `stored id ${mapping.sourceCollectionGid}`,
    mapping.sourceHandle ? `handle "${mapping.sourceHandle}"` : null,
    fallbackQueries.length ? `searches ${fallbackQueries.join(", ")}` : null,
    lookupErrors.length ? `errors: ${lookupErrors.join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  const restCollection = await fetchRestCollectionData(mapping, sourceClient);
  if (restCollection) return restCollection;

  const publicCollection = await findPublicCollectionData(
    mapping,
    sourceClient,
    mapping.destTitle
  );
  if (publicCollection) {
    console.warn(
      `[CollectionSync] Using public storefront collection fallback for ${mapping.sourceCollectionGid} on ${mapping.sourceStore.shopDomain}: ${publicCollection.handle}`
    );
    return {
      id: mapping.sourceCollectionGid,
      title: publicCollection.title,
      handle: publicCollection.handle,
      descriptionHtml: null,
      sortOrder: "MANUAL",
      templateSuffix: null,
      image: null,
      seo: null,
      ruleSet: null,
    };
  }

  console.warn(
    `[CollectionSync] Collection ${mapping.sourceCollectionGid} metadata was not visible on ${mapping.sourceStore.shopDomain}; continuing with minimal collection data so product fallback can run (${lookupDetails})`
  );
  return fallbackCollectionData(mapping);
}

/**
 * Sync a single collection from source to destination
 */
export async function syncCollection(
  mapping: CollectionMappingWithStores,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient,
  runStats?: CollectionSyncRunStats
): Promise<SyncCollectionResult> {
  const startTime = Date.now();
  let sourceCollectionGid = mapping.sourceCollectionGid;

  try {
    const sourceCollection = await fetchSourceCollectionData(
      mapping,
      sourceClient
    );
    const hasUpdatedSourceId =
      sourceCollection.id && sourceCollection.id !== mapping.sourceCollectionGid;
    const hasUpdatedSourceHandle =
      sourceCollection.handle && sourceCollection.handle !== mapping.sourceHandle;
    const effectiveMapping =
      hasUpdatedSourceId || hasUpdatedSourceHandle
        ? {
            ...mapping,
            sourceCollectionGid: sourceCollection.id || mapping.sourceCollectionGid,
            sourceHandle: sourceCollection.handle || mapping.sourceHandle,
          }
        : mapping;

    sourceCollectionGid = effectiveMapping.sourceCollectionGid;

    if (
      effectiveMapping.sourceCollectionGid !== mapping.sourceCollectionGid ||
      effectiveMapping.sourceHandle !== mapping.sourceHandle
    ) {
      await prisma.collectionMapping
        .update({
          where: { id: mapping.id },
          data: {
            sourceCollectionGid: effectiveMapping.sourceCollectionGid,
            sourceHandle: effectiveMapping.sourceHandle,
          },
        })
        .catch((error) =>
          console.warn(
            `[CollectionSync] Could not update mapping ${mapping.id} to live collection ${effectiveMapping.sourceCollectionGid}:`,
            error
          )
        );
    }

    const isNew = !mapping.destCollectionGid;

    // Build collection input
    const collectionInput: any = {
      title: mapping.destTitle || sourceCollection.title,
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
      collectionInput.id = mapping.destCollectionGid;
      destCollectionGid = mapping.destCollectionGid!;

      const updateResult = sourceCollection.ruleSet
        ? await destClient.queryWithRetry(
            COLLECTION_UPDATE_MUTATION,
            { input: collectionInput }
          )
        : await destClient.queryWithRetry(
            COLLECTION_UPDATE_DETAILS_MUTATION,
            { collection: collectionInput }
          );

      if (updateResult.data?.collectionUpdate?.collection) {
        console.log(
          `[CollectionSync] Updated destination collection ${destCollectionGid} sortOrder=${updateResult.data.collectionUpdate.collection.sortOrder || "unknown"}`
        );
      }

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
        effectiveMapping,
        destCollectionGid,
        sourceCollection,
        sourceClient,
        destClient,
        runStats
      );
    }

    await prisma.collectionMapping.update({
      where: { id: mapping.id },
      data: {
        destCollectionGid,
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
  mapping: CollectionMappingWithStores,
  destCollectionGid: string,
  sourceCollection: SourceCollectionData,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient,
  runStats?: CollectionSyncRunStats
): Promise<void> {
  const { sourceStoreId, destStoreId } = mapping;

  // Fetch all product IDs in the source collection, in collection order.
  const sourceProductGids = await fetchSourceCollectionProductGids(
    sourceClient,
    mapping,
    sourceCollection
  );
  if (runStats) {
    runStats.totalProducts = sourceProductGids.length;
    runStats.syncedProducts = 0;
    runStats.failedProducts = 0;
    runStats.skippedProducts = 0;
    runStats.errors = [];
    await updateCollectionRunJob(runStats);
  }

  // Map source product GIDs -> destination product GIDs (only synced products).
  const productMappings = await prisma.productMapping.findMany({
    where: {
      sourceStoreId,
      destStoreId,
      status: "SYNCED",
      destProductGid: { not: null },
    },
    select: { sourceProductGid: true, destProductGid: true },
  });

  const sourceToDest = new Map<string, string>();
  const managedDestIds = new Set<string>();
  for (const m of productMappings) {
    if (m.destProductGid) {
      sourceToDest.set(m.sourceProductGid, m.destProductGid);
      managedDestIds.add(m.destProductGid);
    }
  }

  if (runStats) {
    runStats.syncedProducts = sourceProductGids.filter((gid) => sourceToDest.has(gid)).length;
    await updateCollectionRunJob(runStats);
  }

  // Products in the source collection with no destination mapping yet.
  // Skip them (default), create them on the destination now, or link an
  // already-existing destination product by handle without touching it.
  if (mapping.missingProductAction === "CREATE") {
    // Ad hoc product-sync config built from this mapping's own settings —
    // no SyncRule involved, so two destinations can use different price
    // rules/fields even for the same source collection.
    const priceRule = mapping.createPriceRuleId
      ? await prisma.priceRule.findUnique({ where: { id: mapping.createPriceRuleId } })
      : null;
    const createConfig: SyncRuleWithRelations = {
      sourceStoreId,
      destStoreId,
      sourceStore: mapping.sourceStore,
      destStore: mapping.destStore,
      priceRule,
      excludedFields: null,
      syncProducts: true,
      syncVariants: mapping.createSyncVariants,
      syncInventory: mapping.createSyncInventory,
      syncMetafields: mapping.createSyncMetafields,
      syncImages: mapping.createSyncImages,
      syncSeo: mapping.createSyncSeo,
      syncTags: mapping.createSyncTags,
      destProductStatus: mapping.createDestProductStatus,
    };

    for (const sourceGid of sourceProductGids) {
      if (sourceToDest.has(sourceGid)) continue;

      const result = await syncProduct(createConfig, sourceGid, sourceClient, destClient);

      if (result.success && result.destGid) {
        sourceToDest.set(sourceGid, result.destGid);
        managedDestIds.add(result.destGid);
        if (runStats) runStats.syncedProducts++;

        const extraErrors = await syncProductExtras(
          createConfig,
          sourceGid,
          result.destGid,
          sourceClient,
          destClient
        );
        if (extraErrors.length > 0) {
          console.warn(`[CollectionSync] Extras warnings for ${sourceGid}:`, extraErrors);
        }
      } else if (result.success) {
        if (runStats) runStats.skippedProducts++;
      } else if (runStats) {
        runStats.failedProducts++;
        runStats.errors.push({
          sourceGid: result.sourceGid || sourceGid,
          error: result.error || "Unknown product sync error",
        });
      }

      await prisma.syncLog.create({
        data: {
          storeId: destStoreId,
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
      if (runStats) await updateCollectionRunJob(runStats);
    }
  } else if (mapping.missingProductAction === "LINK_EXISTING") {
    for (const sourceGid of sourceProductGids) {
      if (sourceToDest.has(sourceGid)) continue;

      const linkResult = await linkExistingProductByHandle(
        sourceStoreId,
        destStoreId,
        sourceGid,
        sourceClient,
        destClient
      );

      if (linkResult.success && linkResult.linked && linkResult.destGid) {
        sourceToDest.set(sourceGid, linkResult.destGid);
        managedDestIds.add(linkResult.destGid);
        if (runStats) runStats.syncedProducts++;
      } else if (linkResult.success) {
        if (runStats) runStats.skippedProducts++;
      } else if (runStats) {
        runStats.failedProducts++;
        runStats.errors.push({
          sourceGid,
          error: linkResult.error || "Failed to link existing product by handle",
        });
      }

      await prisma.syncLog.create({
        data: {
          storeId: destStoreId,
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
      if (runStats) await updateCollectionRunJob(runStats);
    }
  } else if (runStats) {
    runStats.skippedProducts = sourceProductGids.length - runStats.syncedProducts;
    await updateCollectionRunJob(runStats);
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
  if (sourceCollection.sortOrder === "MANUAL" && desiredDestIds.length) {
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
      if (res.data?.collectionReorderProducts?.userErrors?.length) {
        console.warn(
          `[CollectionSync] collectionReorderProducts userErrors for ${destCollectionGid}:`,
          JSON.stringify(res.data.collectionReorderProducts.userErrors)
        );
      }
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
 * to the destination collection. Never needs price rule/field settings since
 * it deliberately never touches the linked product's fields.
 */
async function linkExistingProductByHandle(
  sourceStoreId: string,
  destStoreId: string,
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
        sourceStoreId,
        destStoreId,
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
      sourceStoreId,
      destStoreId,
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
  const directGids = await fetchCollectionProductGidsByConnection(client, collectionGid);
  if (directGids) return directGids;

  console.warn(
    `[CollectionSync] Collection ${collectionGid} is not visible via collection(id:); falling back to products collection_id search`
  );
  return fetchProductGidsByCollectionId(client, collectionGid);
}

async function fetchCollectionProductGidsByConnection(
  client: ShopifyGraphQLClient,
  collectionGid: string
): Promise<string[] | null> {
  const gids: string[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await client.queryWithRetry(GET_COLLECTION_PRODUCTS, {
      id: collectionGid,
      first: 100,
      after: cursor,
      sortKey: "COLLECTION_DEFAULT",
    });

    if (result.errors?.length) {
      throw new Error(
        `Failed to fetch collection products for ${collectionGid}: ${result.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`
      );
    }

    const collection = result.data?.collection;
    if (!collection) {
      return null;
    }

    const products = collection.products;
    if (!products) break;

    for (const edge of products.edges) {
      gids.push(edge.node.id);
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  return gids;
}

async function fetchSourceCollectionProductGids(
  sourceClient: ShopifyGraphQLClient,
  mapping: CollectionMappingWithStores,
  sourceCollection: SourceCollectionData
): Promise<string[]> {
  const directGids = await fetchCollectionProductGidsByConnection(
    sourceClient,
    mapping.sourceCollectionGid
  );
  if (directGids) return directGids;

  const publicGids = await fetchPublicCollectionProductGids(
    sourceClient,
    mapping,
    sourceCollection
  );

  if (publicGids.length) {
    const fallbackGids = await fetchProductGidsByCollectionId(
      sourceClient,
      mapping.sourceCollectionGid
    );
    const seen = new Set(publicGids);
    const combined = [
      ...publicGids,
      ...fallbackGids.filter((gid) => !seen.has(gid)),
    ];
    console.log(
      `[CollectionSync] public collection order fallback: ${publicGids.length} ordered products from ${sourceCollection.handle}; ${combined.length} total after appending hidden products`
    );
    return combined;
  }

  console.warn(
    `[CollectionSync] Collection ${mapping.sourceCollectionGid} is not visible via collection(id:) and no public collection order was found; falling back to products collection_id search`
  );
  return fetchProductGidsByCollectionId(sourceClient, mapping.sourceCollectionGid);
}

async function fetchPublicCollectionProductGids(
  sourceClient: ShopifyGraphQLClient,
  mapping: CollectionMappingWithStores,
  sourceCollection: SourceCollectionData
): Promise<string[]> {
  const publicCollection =
    sourceCollection.handle
      ? {
          baseUrl: (
            await fetchPrimaryDomainUrl(sourceClient, mapping.sourceStore.shopDomain)
          )[0],
          title: sourceCollection.title,
          handle: sourceCollection.handle,
          productsCount: null,
        }
      : await findPublicCollectionData(
          mapping,
          sourceClient,
          sourceCollection.title
        );

  if (!publicCollection?.handle) return [];

  const gids: string[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 20; page++) {
    const url = joinUrl(
      publicCollection.baseUrl,
      `/collections/${encodeURIComponent(publicCollection.handle)}/products.json?limit=250&page=${page}`
    );
    const result = await fetchPublicJson<{
      products?: Array<{ id?: number | string }>;
    }>(url);
    const products = result?.products || [];
    if (!products.length) break;

    for (const product of products) {
      if (product.id == null) continue;
      const gid = `gid://shopify/Product/${product.id}`;
      if (!seen.has(gid)) {
        gids.push(gid);
        seen.add(gid);
      }
    }
  }

  if (gids.length && publicCollection.handle !== mapping.sourceHandle) {
    await prisma.collectionMapping
      .update({
        where: { id: mapping.id },
        data: { sourceHandle: publicCollection.handle },
      })
      .catch((error) =>
        console.warn(
          `[CollectionSync] Could not update mapping ${mapping.id} with public handle ${publicCollection.handle}:`,
          error
        )
      );
  }

  return gids;
}

async function fetchProductGidsByCollectionId(
  client: ShopifyGraphQLClient,
  collectionGid: string
): Promise<string[]> {
  const collectionId = legacyCollectionIdFromGid(collectionGid);
  if (!collectionId) {
    throw new Error(`Invalid Shopify collection ID: ${collectionGid}`);
  }

  const gids: string[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  while (hasNext) {
    const result: any = await client.queryWithRetry(
      `#graphql
      query GetProductsByCollectionId($query: String!, $first: Int!, $after: String) {
        products(first: $first, after: $after, query: $query) {
          edges {
            node { id }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { query: `collection_id:${collectionId}`, first: 100, after: cursor }
    );

    if (result.errors?.length) {
      throw new Error(
        `Failed to fetch products for collection ${collectionGid}: ${result.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`
      );
    }

    const products = result.data?.products;
    if (!products) break;

    for (const edge of products.edges) {
      gids.push(edge.node.id);
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  console.log(
    `[CollectionSync] collection_id fallback: ${gids.length} products from ${collectionGid}`
  );
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
  mapping: CollectionMappingWithStores,
  destClient: ShopifyGraphQLClient
): Promise<SyncCollectionResult> {
  const startTime = Date.now();
  const sourceCollectionGid = mapping.sourceCollectionGid;

  if (!mapping.destCollectionGid) {
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
  sourceClient: ShopifyGraphQLClient,
  searchQuery?: string
): Promise<Array<{ id: string; title: string; handle: string }>> {
  const PICKER_COLLECTIONS_QUERY = `#graphql
    query GetPickerCollections($first: Int!, $after: String, $query: String) {
      collections(first: $first, after: $after, query: $query, sortKey: TITLE) {
        edges {
          node {
            id
            title
            handle
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const byId = new Map<string, { id: string; title: string; handle: string }>();
  const errors: string[] = [];
  const rawQuery = searchQuery?.trim();
  const handleQuery = rawQuery?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const queryVariants: Array<string | undefined> = rawQuery
    ? [
        rawQuery,
        `title:${rawQuery}*`,
        handleQuery ? `handle:${handleQuery}*` : undefined,
        `collection_type:smart title:${rawQuery}*`,
        `collection_type:custom title:${rawQuery}*`,
        undefined,
      ]
    : [undefined];

  for (const query of queryVariants) {
    let hasNext = true;
    let cursor: string | null = null;

    while (hasNext) {
      const result: any = await sourceClient.queryWithRetry(PICKER_COLLECTIONS_QUERY, {
        first: 50,
        after: cursor,
        query,
      });

      if (result.errors?.length) {
        errors.push(
          `${query || "all collections"}: ${result.errors
            .map((error: { message: string }) => error.message)
            .join("; ")}`
        );
        break;
      }

      const data = result.data?.collections;
      if (!data) break;

      for (const edge of data.edges) {
        byId.set(edge.node.id, {
          id: edge.node.id,
          title: edge.node.title,
          handle: edge.node.handle,
        });
      }

      hasNext = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
    }
  }

  let collections = [...byId.values()];
  if (collections.length === 0 && errors.length > 0) {
    throw new Error(`Failed to fetch collections: ${errors.join(" | ")}`);
  }

  if (rawQuery) {
    const normalizedQuery = rawQuery.toLowerCase();
    collections = collections.filter((collection) =>
      `${collection.title} ${collection.handle}`.toLowerCase().includes(normalizedQuery)
    );
  }

  return collections.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Manually re-sync a single collection mapping right now (the "Sync now"
 * button on the Collection Mapping page), instead of waiting for the next
 * collections/update webhook. Fire-and-forget from the caller's perspective —
 * this can take a while for large collections (add/remove/reorder jobs are
 * polled to completion), so callers should not await this on a request that
 * needs to return quickly.
 */
export async function triggerManualCollectionSync(
  mappingId: string
): Promise<{ jobId: string; queued: number; errors: string[] }> {
  const mapping = await prisma.collectionMapping.findUnique({
    where: { id: mappingId },
    include: { sourceStore: true, destStore: true },
  });

  if (!mapping) throw new Error("Collection mapping not found");

  const job = await prisma.syncJob.create({
    data: {
      syncRuleId: mapping.id,
      totalProducts: 0,
      trigger: "MANUAL",
    },
  });

  const runBackground = async () => {
    const runStats: CollectionSyncRunStats = {
      jobId: job.id,
      totalProducts: 0,
      syncedProducts: 0,
      failedProducts: 0,
      skippedProducts: 0,
      errors: [],
    };

    try {
      const sourceClient = await createClientForStore(mapping.sourceStoreId);
      const destClient = await createClientForStore(mapping.destStoreId);
      const result = await syncCollection(mapping, sourceClient, destClient, runStats);

      if (!result.success) {
        runStats.errors.push({
          sourceGid: result.sourceGid,
          error: result.error || "Collection sync failed",
        });
      }

      await prisma.syncLog.create({
        data: {
          storeId: mapping.destStoreId,
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

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status:
            result.success && runStats.failedProducts === 0
              ? "COMPLETED"
              : result.success
                ? "COMPLETED_WITH_ERRORS"
                : "FAILED",
          totalProducts: runStats.totalProducts,
          syncedProducts: runStats.syncedProducts,
          failedProducts: runStats.failedProducts,
          skippedProducts: runStats.skippedProducts,
          errors: runStats.errors.length > 0 ? JSON.stringify(runStats.errors.slice(0, 50)) : null,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      console.error(`[CollectionSync] Job ${job.id} FAILED:`, error);
      runStats.errors.push({
        sourceGid: mapping.sourceCollectionGid,
        error: (error as Error).message,
      });
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          totalProducts: runStats.totalProducts,
          syncedProducts: runStats.syncedProducts,
          failedProducts: runStats.failedProducts,
          skippedProducts: runStats.skippedProducts,
          errors: JSON.stringify(runStats.errors.slice(0, 50)),
          completedAt: new Date(),
        },
      });
    }
  };

  runBackground().catch((err) =>
    console.error(`[CollectionSync] Background sync fatal:`, err)
  );

  return { jobId: job.id, queued: 0, errors: [] };
}
