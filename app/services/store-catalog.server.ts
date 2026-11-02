import prisma from "../db.server";
import { createClientForStore } from "./shopify-client.server";
import type { CatalogCounts } from "./catalog-reconciliation.server";
import { PRODUCT_STATUSES } from "./catalog-selection";

export const STORE_COUNTS_QUERY = `#graphql
  query DashboardStoreCounts {
    total: productsCount(limit: null) { count precision }
    active: productsCount(limit: null, query: "status:active") { count precision }
    draft: productsCount(limit: null, query: "status:draft") { count precision }
    unlisted: productsCount(limit: null, query: "status:unlisted") { count precision }
    archived: productsCount(limit: null, query: "status:archived") { count precision }
  }
`;

export async function getStoreCatalogCounts(
  ownerShop: string,
  storeId: string,
) {
  // Counts are independent of SyncRule and CatalogJob, including on first setup.
  const store = await prisma.connectedStore.findFirst({
    where: { id: storeId, ownerShop, status: { not: "DISCONNECTED" } },
    select: { id: true },
  });
  if (!store) throw new Error("Connected store not found for this account");
  const client = await createClientForStore(store.id);
  type Count = { count: number; precision: string };
  const response =
    await client.queryWithRetry<
      Record<"total" | "active" | "draft" | "unlisted" | "archived", Count>
    >(STORE_COUNTS_QUERY);
  if (response.errors?.length || !response.data)
    throw new Error(
      response.errors?.map((e) => e.message).join("; ") ||
        "Shopify returned no product counts",
    );
  const data = response.data;
  let counts: CatalogCounts = {
    total: data.total.count,
    ACTIVE: data.active.count,
    DRAFT: data.draft.count,
    UNLISTED: data.unlisted.count,
    ARCHIVED: data.archived.count,
    precision: "EXACT",
  };
  // Never label a bounded/estimated Shopify count as exact.
  if (Object.values(data).some((count) => count.precision !== "EXACT")) {
    counts = {
      total: 0,
      ACTIVE: 0,
      DRAFT: 0,
      UNLISTED: 0,
      ARCHIVED: 0,
      precision: "EXACT",
    };
    let after: string | null = null;
    do {
      const page: {
        data?: {
          products: {
            nodes: Array<{ status: string }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
        errors?: Array<{ message: string }>;
      } = await client.queryWithRetry<{
        products: {
          nodes: Array<{ status: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(
        `#graphql
        query DashboardStoreStatusPage($after: String) {
          products(first: 250, after: $after) {
            nodes { status }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
      );
      if (page.errors?.length || !page.data?.products)
        throw new Error(
          page.errors?.map((e) => e.message).join("; ") ||
            "Could not read product status counts",
        );
      for (const product of page.data.products.nodes) {
        if (!(PRODUCT_STATUSES as readonly string[]).includes(product.status))
          throw new Error("Shopify returned an unsupported product status");
        counts[product.status as (typeof PRODUCT_STATUSES)[number]]++;
        counts.total++;
      }
      const info = page.data.products.pageInfo;
      if (info.hasNextPage && (!info.endCursor || info.endCursor === after))
        throw new Error(
          "Could not finish reading product counts. Please refresh.",
        );
      after = info.hasNextPage ? info.endCursor : null;
    } while (after);
  }
  return { storeId, counts, refreshedAt: new Date().toISOString() };
}
