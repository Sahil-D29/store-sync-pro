import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  createClientForStore,
  type ShopifyGraphQLClient,
} from "./shopify-client.server";
import { syncProduct } from "./product-sync.server";
import { syncProductExtras } from "./product-extras.server";
import {
  PRODUCT_STATUSES,
  matchesCatalogRule,
  matchVariants,
  selectRemaining,
} from "./catalog-selection";
import type {
  CatalogProduct,
  CatalogSelection,
  CatalogVariant,
  RemainingProduct,
} from "./catalog-selection";

export type CatalogCounts = {
  total: number;
  ACTIVE: number;
  DRAFT: number;
  UNLISTED: number;
  ARCHIVED: number;
  precision: "EXACT";
};
export type CatalogSnapshot = {
  sourceCounts: CatalogCounts | null;
  destCounts: CatalogCounts | null;
  sourceError: string | null;
  destError: string | null;
  products: RemainingProduct[];
  refreshedAt: string;
};
export type CatalogResult = {
  matched: number;
  synced: number;
  failed: number;
  skipped: number;
  conflicts: string[];
};
const asJson = (value: unknown) => value as Prisma.InputJsonValue;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function accountRule(ownerShop: string, ruleId: string) {
  const rule = await prisma.syncRule.findFirst({
    where: { id: ruleId, ownerShop },
    include: { sourceStore: true, destStore: true, priceRule: true },
  });
  if (!rule) throw new Error("Sync rule not found for this account");
  if (!rule.isActive || !rule.syncProducts)
    throw new Error("Choose an active rule with product sync enabled");
  if (
    rule.sourceStore.ownerShop !== ownerShop ||
    rule.destStore.ownerShop !== ownerShop ||
    rule.sourceStore.status !== "ACTIVE" ||
    rule.destStore.status !== "ACTIVE"
  )
    throw new Error("Both stores must be active and belong to this account");
  return rule;
}

async function query<T>(
  client: ShopifyGraphQLClient,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await client.queryWithRetry<T>(document, variables);
  if (response.errors?.length || !response.data)
    throw new Error(
      response.errors?.map((e) => e.message).join("; ") ||
        "Shopify returned no catalog data",
    );
  return response.data;
}
type Connection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
export const CATALOG_QUERY = `#graphql
  query DashboardCatalog($after: String, $withCollections: Boolean!) {
    products(first: 25, after: $after) {
      nodes {
        id title handle status tags
        collections(first: 10) @include(if: $withCollections) {
          nodes { id title }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
export const CURRENT_PRODUCT_QUERY = `#graphql
  query DashboardCurrentProduct($id: ID!) {
    product(id: $id) {
      id title handle status tags
      collections(first: 100) { nodes { id title } pageInfo { hasNextPage endCursor } }
    }
  }`;
export const HANDLE_QUERY = `#graphql
  query DashboardExactHandle($query: String!) {
    products(first: 2, query: $query) { nodes { id handle } }
  }`;
export const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query DashboardProductCollections($id: ID!, $after: String) {
    product(id: $id) {
      collections(first: 100, after: $after) {
        nodes { id title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
export const PRODUCT_VARIANTS_QUERY = `#graphql
  query DashboardProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 100, after: $after) {
        nodes { id sku selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
async function catalog(
  client: ShopifyGraphQLClient,
  withCollections: boolean,
  heartbeat: () => Promise<void>,
) {
  const products: CatalogProduct[] = [];
  const membershipPages: Array<{ product: CatalogProduct; after: string }> = [];
  let after: string | null = null;
  do {
    await heartbeat();
    const data: {
      products: Connection<
        Omit<CatalogProduct, "collections"> & {
          collections?: Connection<{ id: string; title: string }>;
        }
      >;
    } = await query(client, CATALOG_QUERY, { after, withCollections });
    for (const product of data.products.nodes) {
      if (!(PRODUCT_STATUSES as readonly string[]).includes(product.status))
        throw new Error(`Unsupported product status: ${product.status}`);
      const normalized = {
        ...product,
        collections: product.collections?.nodes || [],
      };
      products.push(normalized);
      if (
        product.collections?.pageInfo.hasNextPage &&
        product.collections.pageInfo.endCursor
      )
        membershipPages.push({
          product: normalized,
          after: product.collections.pageInfo.endCursor,
        });
    }
    after = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (after);
  // Source memberships are paginated independently, avoiding nested connection truncation.
  for (const pending of membershipPages) {
    const product = pending.product;
    after = pending.after;
    do {
      await heartbeat();
      const data: {
        product: {
          collections: Connection<{ id: string; title: string }>;
        } | null;
      } = await query(client, PRODUCT_COLLECTIONS_QUERY, {
        id: product.id,
        after,
      });
      if (!data.product)
        throw new Error(
          "Source catalog changed during comparison. Refresh the catalog.",
        );
      product.collections.push(...data.product.collections.nodes);
      after = data.product.collections.pageInfo.hasNextPage
        ? data.product.collections.pageInfo.endCursor
        : null;
    } while (after);
  }
  return products;
}
async function currentProduct(
  client: ShopifyGraphQLClient,
  id: string,
): Promise<CatalogProduct | null> {
  const data: {
    product:
      | (Omit<CatalogProduct, "collections"> & {
          collections: Connection<{ id: string; title: string }>;
        })
      | null;
  } = await query(client, CURRENT_PRODUCT_QUERY, { id });
  if (!data.product) return null;
  const product: CatalogProduct = {
    ...data.product,
    collections: [...data.product.collections.nodes],
  };
  let after = data.product.collections.pageInfo.hasNextPage
    ? data.product.collections.pageInfo.endCursor
    : null;
  while (after) {
    const page: {
      product: {
        collections: Connection<{ id: string; title: string }>;
      } | null;
    } = await query(client, PRODUCT_COLLECTIONS_QUERY, { id, after });
    if (!page.product) return null;
    product.collections.push(...page.product.collections.nodes);
    after = page.product.collections.pageInfo.hasNextPage
      ? page.product.collections.pageInfo.endCursor
      : null;
  }
  return product;
}
function counts(products: CatalogProduct[]): CatalogCounts {
  const result: CatalogCounts = {
    total: products.length,
    ACTIVE: 0,
    DRAFT: 0,
    UNLISTED: 0,
    ARCHIVED: 0,
    precision: "EXACT",
  };
  for (const product of products) result[product.status]++;
  return result;
}
async function variants(client: ShopifyGraphQLClient, id: string) {
  const output: CatalogVariant[] = [];
  let after: string | null = null;
  do {
    const data: { product: { variants: Connection<CatalogVariant> } | null } =
      await query(client, PRODUCT_VARIANTS_QUERY, { id, after });
    if (!data.product)
      throw new Error("Product no longer exists. Refresh the catalog.");
    output.push(...data.product.variants.nodes);
    after = data.product.variants.pageInfo.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
  } while (after);
  return output;
}
async function scan(
  rule: Awaited<ReturnType<typeof accountRule>>,
  heartbeat: () => Promise<void>,
) {
  const settled = await Promise.allSettled([
    createClientForStore(rule.sourceStoreId).then((client) =>
      catalog(client, true, heartbeat),
    ),
    createClientForStore(rule.destStoreId).then((client) =>
      catalog(client, false, heartbeat),
    ),
  ]);
  const source = settled[0].status === "fulfilled" ? settled[0].value : null;
  const destination =
    settled[1].status === "fulfilled" ? settled[1].value : null;
  const snapshot: CatalogSnapshot = {
    sourceCounts: source ? counts(source) : null,
    destCounts: destination ? counts(destination) : null,
    sourceError:
      settled[0].status === "rejected" ? errorMessage(settled[0].reason) : null,
    destError:
      settled[1].status === "rejected" ? errorMessage(settled[1].reason) : null,
    products: [],
    refreshedAt: new Date().toISOString(),
  };
  if (source && destination) {
    const [mappings, failures] = await Promise.all([
      prisma.productMapping.findMany({
        where: {
          sourceStoreId: rule.sourceStoreId,
          destStoreId: rule.destStoreId,
        },
      }),
      prisma.syncLog.findMany({
        where: {
          syncRuleId: rule.id,
          resourceType: "PRODUCT",
          sourceGid: { not: null },
        },
        orderBy: { createdAt: "desc" },
        distinct: ["sourceGid"],
        select: { sourceGid: true, status: true },
      }),
    ]);
    const mappingBySource = new Map(
      mappings.map((m) => [m.sourceProductGid, m]),
    );
    const latestFailure = new Set(
      failures
        .filter((log) => log.status === "FAILED")
        .map((log) => log.sourceGid),
    );
    const destinationIds = new Set(destination.map((p) => p.id));
    snapshot.products = source
      .filter((p) => matchesCatalogRule(p, rule))
      .map((p) => {
        const mapping = mappingBySource.get(p.id);
        const destId =
          mapping?.destProductGid && destinationIds.has(mapping.destProductGid)
            ? mapping.destProductGid
            : null;
        const state =
          latestFailure.has(p.id) || mapping?.status === "ERROR"
            ? "FAILED"
            : !destId
              ? "UNMATCHED"
              : mapping?.status === "SYNCED" && mapping.lastSyncedAt
                ? "SYNCED"
                : "MATCHED";
        return { ...p, state, destId };
      });
  }
  return { snapshot, destination: destination || [] };
}

export async function latestCatalog(ownerShop: string, ruleId: string) {
  await accountRule(ownerShop, ruleId);
  await expireStaleJobs();
  const [job, completed] = await Promise.all([
    prisma.catalogJob.findFirst({
      where: { ownerShop, syncRuleId: ruleId },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        operation: true,
        status: true,
        processed: true,
        total: true,
        result: true,
        error: true,
      },
    }),
    prisma.catalogJob.findFirst({
      where: {
        ownerShop,
        syncRuleId: ruleId,
        status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      },
      orderBy: { startedAt: "desc" },
      select: { snapshot: true, id: true },
    }),
  ]);
  return {
    job,
    snapshotId: completed?.id || null,
    snapshot: completed?.snapshot as CatalogSnapshot | null,
  };
}
async function expireStaleJobs() {
  await prisma.catalogJob.updateMany({
    where: {
      status: "RUNNING",
      updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
    },
    data: {
      status: "FAILED",
      error: "Job interrupted. Refresh and retry.",
      activePair: null,
      completedAt: new Date(),
    },
  });
}
export async function startCatalogJob(
  ownerShop: string,
  ruleId: string,
  operation: "COMPARE" | "MATCH" | "SYNC",
  selection?: CatalogSelection,
  snapshotId?: string,
) {
  const rule = await accountRule(ownerShop, ruleId);
  await expireStaleJobs();
  let previewIds: string[] = [];
  if (operation === "SYNC") {
    if (!selection || !snapshotId)
      throw new Error("Preview your selection before syncing");
    const preview = await prisma.catalogJob.findFirst({
      where: {
        id: snapshotId,
        ownerShop,
        syncRuleId: ruleId,
        status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      },
    });
    const snapshot = preview?.snapshot as CatalogSnapshot | null;
    if (!snapshot || snapshot.sourceError || snapshot.destError)
      throw new Error("Refresh the catalog before syncing");
    previewIds = selectRemaining(snapshot.products, selection).map((p) => p.id);
    if (!previewIds.length)
      throw new Error("No remaining products match this selection");
  }
  let job;
  try {
    job = await prisma.$transaction(async (tx) => {
      const pair = `${rule.sourceStoreId}:${rule.destStoreId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pair}))`;
      if (await tx.catalogJob.findUnique({ where: { activePair: pair } }))
        throw new Error(
          "A catalog operation is already running for these stores",
        );
      const ruleIds = (
        await tx.syncRule.findMany({
          where: {
            sourceStoreId: rule.sourceStoreId,
            destStoreId: rule.destStoreId,
          },
          select: { id: true },
        })
      ).map((r) => r.id);
      if (
        await tx.syncJob.findFirst({
          where: { status: "RUNNING", syncRuleId: { in: ruleIds } },
        })
      )
        throw new Error("A product sync is already running for these stores");
      return tx.catalogJob.create({
        data: { ownerShop, syncRuleId: ruleId, operation, activePair: pair },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002")
      throw new Error(
        "A catalog operation is already running for these stores",
      );
    throw error;
  }
  // Same background execution model as the existing manual-sync service. DB leases
  // survive reloads and release interrupted jobs; every write checks the lease.
  void runCatalogJob(
    job.id,
    ownerShop,
    ruleId,
    operation,
    selection,
    previewIds,
  ).catch((error) =>
    console.error("[Catalog] Job failed", errorMessage(error)),
  );
  return job.id;
}

async function runCatalogJob(
  id: string,
  ownerShop: string,
  ruleId: string,
  operation: string,
  selection: CatalogSelection | undefined,
  previewIds: string[],
) {
  const heartbeat = async () => {
    const update = await prisma.catalogJob.updateMany({
      where: { id, status: "RUNNING" },
      data: { updatedAt: new Date() },
    });
    if (update.count !== 1) throw new Error("Catalog job lease expired");
  };
  const timer = setInterval(() => {
    void heartbeat().catch(() => {});
  }, 20_000);
  timer.unref();
  const result: CatalogResult = {
    matched: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    conflicts: [],
  };
  try {
    const rule = await accountRule(ownerShop, ruleId);
    const initial = await scan(rule, heartbeat);
    if (
      operation !== "COMPARE" &&
      (initial.snapshot.sourceError || initial.snapshot.destError)
    )
      throw new Error(
        initial.snapshot.sourceError ||
          initial.snapshot.destError ||
          "Catalog unavailable",
      );
    if (operation !== "COMPARE") {
      const sourceClient = await createClientForStore(rule.sourceStoreId);
      const destClient = await createClientForStore(rule.destStoreId);
      const requested = new Set(previewIds);
      const products =
        operation === "MATCH"
          ? initial.snapshot.products.filter((p) => p.state !== "SYNCED")
          : selectRemaining(initial.snapshot.products, selection!).filter((p) =>
              requested.has(p.id),
            );
      if (operation === "SYNC")
        result.skipped = previewIds.length - products.length;
      await prisma.catalogJob.update({
        where: { id },
        data: { total: products.length },
      });
      const mappings = await prisma.productMapping.findMany({
        where: { destStoreId: rule.destStoreId },
      });
      const claims = new Map(
        mappings
          .filter((m) => m.destProductGid)
          .map((m) => [
            m.destProductGid!,
            `${m.sourceStoreId}:${m.sourceProductGid}`,
          ]),
      );
      for (const [index, scannedProduct] of products.entries()) {
        await heartbeat();
        let logged = false;
        try {
          // Revalidate saved rule and product eligibility immediately before writing.
          const currentRule = await accountRule(ownerShop, ruleId);
          if (
            currentRule.sourceStoreId !== rule.sourceStoreId ||
            currentRule.destStoreId !== rule.destStoreId
          )
            throw new Error("Rule stores changed. Refresh and retry.");
          if (
            JSON.stringify([
              currentRule.filterType,
              currentRule.filterProductIds,
              currentRule.filterCollectionIds,
              currentRule.filterTags,
            ]) !==
            JSON.stringify([
              rule.filterType,
              rule.filterProductIds,
              rule.filterCollectionIds,
              rule.filterTags,
            ])
          )
            throw new Error(
              "Sync rule changed during this operation. Refresh and retry.",
            );
          const liveMapping = await prisma.productMapping.findUnique({
            where: {
              sourceStoreId_destStoreId_sourceProductGid: {
                sourceStoreId: rule.sourceStoreId,
                destStoreId: rule.destStoreId,
                sourceProductGid: scannedProduct.id,
              },
            },
          });
          if (
            operation === "SYNC" &&
            liveMapping?.status === "SYNCED" &&
            liveMapping.lastSyncedAt &&
            liveMapping.destProductGid
          ) {
            const latestLog = await prisma.syncLog.findFirst({
              where: {
                syncRuleId: ruleId,
                sourceGid: scannedProduct.id,
                resourceType: "PRODUCT",
              },
              orderBy: { createdAt: "desc" },
              select: { status: true },
            });
            const liveDestination: { product: { id: string } | null } =
              await query(
                destClient,
                `query DashboardMappedProduct($id: ID!) { product(id: $id) { id handle } }`,
                { id: liveMapping.destProductGid },
              );
            if (latestLog?.status !== "FAILED" && liveDestination.product) {
              result.skipped++;
              continue;
            }
          }
          const fresh = await currentProduct(sourceClient, scannedProduct.id);
          const product = fresh
            ? {
                ...fresh,
                state: scannedProduct.state,
                destId: liveMapping?.destProductGid || scannedProduct.destId,
              }
            : null;
          if (
            !product ||
            !matchesCatalogRule(product, currentRule) ||
            (operation === "SYNC" &&
              !selectRemaining([product], selection!).length)
          ) {
            result.skipped++;
            continue;
          }
          // Existing mappings may intentionally have different handles. Preserve
          // them while checking existence; all new links require an exact handle.
          let candidate: { id: string; handle: string } | undefined;
          if (product.destId) {
            const existingDest: {
              product: { id: string; handle: string } | null;
            } = await query(
              destClient,
              `query DashboardMappedProduct($id: ID!) { product(id: $id) { id handle } }`,
              { id: product.destId },
            );
            candidate = existingDest.product || undefined;
          }
          if (!candidate) {
            const byHandle: {
              products: { nodes: Array<{ id: string; handle: string }> };
            } = await query(destClient, HANDLE_QUERY, {
              query: `handle:${JSON.stringify(product.handle)}`,
            });
            candidate = byHandle.products.nodes.find(
              (p) => p.handle === product.handle,
            );
          }
          const sourceVariants =
            operation === "SYNC" || candidate
              ? await variants(sourceClient, product.id)
              : [];
          if (operation === "SYNC" && sourceVariants.length > 100)
            throw new Error(
              "This product has more than 100 variants; the current product sync engine supports up to 100. No product changes were made.",
            );
          if (candidate) {
            const claimedBy = claims.get(candidate.id);
            if (
              claimedBy &&
              claimedBy !== `${rule.sourceStoreId}:${product.id}`
            )
              throw new Error(
                `${product.handle}: destination is already linked to another source product`,
              );
            const destVariants = await variants(destClient, candidate.id);
            const variantMappings = matchVariants(sourceVariants, destVariants);
            if (!variantMappings)
              throw new Error(
                `${product.handle}: variant options differ; review the products before syncing`,
              );
            await heartbeat();
            const existing = await prisma.productMapping.findUnique({
              where: {
                sourceStoreId_destStoreId_sourceProductGid: {
                  sourceStoreId: rule.sourceStoreId,
                  destStoreId: rule.destStoreId,
                  sourceProductGid: product.id,
                },
              },
            });
            if (
              !existing?.destProductGid ||
              existing.destProductGid !== candidate.id
            ) {
              const destinationId = candidate.id;
              await prisma.$transaction(async (tx) => {
                const destinationKey = `catalog-destination:${rule.destStoreId}:${destinationId}`;
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${destinationKey}))`;
                const conflict = await tx.productMapping.findFirst({
                  where: {
                    destStoreId: rule.destStoreId,
                    destProductGid: destinationId,
                    OR: [
                      { sourceStoreId: { not: rule.sourceStoreId } },
                      { sourceProductGid: { not: product.id } },
                    ],
                  },
                });
                if (conflict)
                  throw new Error(
                    "Destination is already linked to another source product",
                  );
                await tx.productMapping.upsert({
                  where: {
                    sourceStoreId_destStoreId_sourceProductGid: {
                      sourceStoreId: rule.sourceStoreId,
                      destStoreId: rule.destStoreId,
                      sourceProductGid: product.id,
                    },
                  },
                  create: {
                    sourceStoreId: rule.sourceStoreId,
                    destStoreId: rule.destStoreId,
                    sourceProductGid: product.id,
                    sourceHandle: product.handle,
                    destProductGid: destinationId,
                    variantMappings: JSON.stringify(variantMappings),
                    status: "MATCHED",
                  },
                  update: {
                    destProductGid: destinationId,
                    sourceHandle: product.handle,
                    variantMappings: JSON.stringify(variantMappings),
                    status: "MATCHED",
                    syncHash: null,
                    lastSyncedAt: null,
                  },
                });
              });
              result.matched++;
            }
            claims.set(candidate.id, `${rule.sourceStoreId}:${product.id}`);
          } else if (operation === "MATCH") {
            result.skipped++;
          } else {
            // Remove only stale mappings, so productSet cannot target a deleted ID.
            await prisma.productMapping.deleteMany({
              where: {
                sourceStoreId: rule.sourceStoreId,
                destStoreId: rule.destStoreId,
                sourceProductGid: product.id,
              },
            });
          }
          if (operation === "SYNC") {
            await heartbeat();
            const sync = await syncProduct(
              currentRule,
              product.id,
              sourceClient,
              destClient,
              true,
            );
            const extras =
              sync.success && sync.destGid
                ? await syncProductExtras(
                    currentRule,
                    product.id,
                    sync.destGid,
                    sourceClient,
                    destClient,
                  )
                : [];
            const success = sync.success && extras.length === 0;
            await prisma.syncLog.create({
              data: {
                syncRuleId: rule.id,
                storeId: rule.destStoreId,
                resourceType: "PRODUCT",
                action: sync.action,
                sourceGid: product.id,
                destGid: sync.destGid,
                status: success ? "SUCCESS" : "FAILED",
                trigger: "MANUAL",
                message: "Selective remaining-product sync",
                errorDetail: sync.error || extras.join("; ") || null,
                duration: sync.duration,
              },
            });
            logged = true;
            if (!success) throw new Error(sync.error || extras.join("; "));
            result.synced++;
          }
        } catch (error) {
          result.failed++;
          if (operation === "SYNC" && !logged)
            await prisma.syncLog.create({
              data: {
                syncRuleId: rule.id,
                storeId: rule.destStoreId,
                resourceType: "PRODUCT",
                action: "SKIP",
                sourceGid: scannedProduct.id,
                status: "FAILED",
                trigger: "MANUAL",
                errorDetail: errorMessage(error),
              },
            });
          if (result.conflicts.length < 50)
            result.conflicts.push(
              `${scannedProduct.handle}: ${errorMessage(error)}`,
            );
        } finally {
          await prisma.catalogJob.updateMany({
            where: { id, status: "RUNNING" },
            data: { processed: index + 1, result: asJson(result) },
          });
        }
      }
    }
    const final =
      operation === "COMPARE"
        ? initial
        : await scan(await accountRule(ownerShop, ruleId), heartbeat);
    await heartbeat();
    await prisma.catalogJob.updateMany({
      where: { id, status: "RUNNING" },
      data: {
        status:
          result.failed ||
          final.snapshot.sourceError ||
          final.snapshot.destError
            ? "COMPLETED_WITH_ERRORS"
            : "COMPLETED",
        result: asJson(result),
        snapshot: asJson(final.snapshot),
        activePair: null,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.catalogJob.updateMany({
      where: { id, status: "RUNNING" },
      data: {
        status: "FAILED",
        error: errorMessage(error),
        result: asJson(result),
        activePair: null,
        completedAt: new Date(),
      },
    });
  } finally {
    clearInterval(timer);
  }
}
