import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogProduct } from "../app/services/catalog-selection";
import { DEFAULT_SELECTION } from "../app/services/catalog-selection";

// Run only against a disposable local DB, after prisma migrate deploy.
const enabled = process.env.CATALOG_TEST_DATABASE_URL;
test(
  "catalog workflow: pagination, matching, selective writes, retries, isolation and locks",
  { skip: !enabled },
  async () => {
    assert.match(
      enabled!,
      /^postgresql:\/\/[^@]+@127\.0\.0\.1:/,
      "Integration tests require an isolated localhost database",
    );
    process.env.DATABASE_URL = enabled;
    const { default: db } = await import("../app/db.server");
    const { startCatalogJob, latestCatalog } =
      await import("../app/services/catalog-reconciliation.server");
    const suffix = Date.now();
    const owner = `source-${suffix}.myshopify.com`;
    const destDomain = `dest-${suffix}.myshopify.com`;
    const originalFetch = globalThis.fetch;
    const source: CatalogProduct[] = Array.from({ length: 27 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`,
      title: `Product ${i + 1}`,
      handle: `product-${i + 1}`,
      status: ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"][
        i % 4
      ] as CatalogProduct["status"],
      tags: i % 2 ? ["Summer"] : ["Summer", "Sale"],
      collections: [{ id: "gid://shopify/Collection/1", title: "Summer" }],
    }));
    const destination = source
      .slice(0, 3)
      .map((p, i) => ({ ...p, id: `gid://shopify/Product/${101 + i}` }));
    let destinationUnavailable = false;
    let boundedCounts = false;
    let catalogGate: Promise<void> | null = null;
    let releaseCatalog: (() => void) | undefined;
    let mutations = 0;
    let failedHandle: string | null = null;
    const page = <T>(nodes: T[], after: string | null, limit: number) => {
      const start = after ? Number(after) : 0;
      const end = start + limit;
      return {
        nodes: nodes.slice(start, end),
        pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
      };
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.ok(
        [owner, destDomain].includes(url.hostname),
        `Unexpected network request: ${url.hostname}`,
      );
      const { query, variables = {} } = JSON.parse(String(init?.body));
      const isSource = url.hostname === owner;
      const list = isSource ? source : destination;
      const product = list.find((p) => p.id === variables.id);
      const variant = (p: CatalogProduct) => ({
        id: p.id.replace("/Product/", "/ProductVariant/"),
        sku: p.handle,
        title: "Default Title",
        selectedOptions: [{ name: "Title", value: "Default Title" }],
      });
      let data: unknown;
      if (destinationUnavailable && !isSource)
        return new Response(
          JSON.stringify({ errors: [{ message: "Destination unavailable" }] }),
          { status: 200 },
        );
      if (query.includes("DashboardStoreCounts")) {
        data = Object.fromEntries(["total", "active", "draft", "unlisted", "archived"].map(key => [key, { count: key === "total" ? list.length : list.filter(p => p.status === key.toUpperCase()).length, precision: boundedCounts ? "AT_LEAST" : "EXACT" }]));
      } else if (query.includes("DashboardStoreStatusPage")) {
        data = { products: page(list.map(p => ({ status: p.status })), variables.after, 20) };
      } else if (query.includes("DashboardCatalog")) {
        if (isSource && catalogGate) await catalogGate;
        data = {
          products: page(
            list.map((p) => ({
              ...p,
              collections: variables.withCollections
                ? page(p.collections, null, 10)
                : undefined,
            })),
            variables.after,
            25,
          ),
        };
      } else if (query.includes("DashboardCurrentProduct")) {
        data = {
          product: product
            ? { ...product, collections: page(product.collections, null, 100) }
            : null,
        };
      } else if (query.includes("DashboardProductCollections")) {
        data = {
          product: product
            ? { collections: page(product.collections, variables.after, 100) }
            : null,
        };
      } else if (query.includes("DashboardProductVariants")) {
        data = {
          product: product
            ? { variants: page([variant(product)], variables.after, 100) }
            : null,
        };
      } else if (query.includes("DashboardMappedProduct")) {
        data = {
          product: product ? { id: product.id, handle: product.handle } : null,
        };
      } else if (query.includes("DashboardExactHandle")) {
        const handle = JSON.parse(variables.query.slice("handle:".length));
        data = {
          products: {
            nodes: list
              .filter((p) => p.handle === handle)
              .map((p) => ({ id: p.id, handle: p.handle })),
          },
        };
      } else if (query.includes("GetProductForSync")) {
        data = {
          product: product
            ? {
                ...product,
                descriptionHtml: "",
                vendor: "Demo",
                productType: "",
                seo: {},
                options: [
                  { name: "Title", position: 1, values: ["Default Title"] },
                ],
                variants: {
                  edges: [
                    {
                      node: {
                        ...variant(product),
                        price: "10.00",
                        compareAtPrice: null,
                        barcode: "",
                        inventoryPolicy: "DENY",
                        inventoryItem: { id: "inventory-test", tracked: false },
                      },
                    },
                  ],
                },
                metafields: { edges: [] },
                images: { edges: [] },
              }
            : null,
        };
      } else if (query.includes("mutation ProductSet")) {
        assert.equal(isSource, false, "Source products must never be mutated");
        mutations++;
        const input = variables.input;
        if (input.handle === failedHandle)
          data = {
            productSet: {
              product: null,
              userErrors: [
                { message: "Simulated product failure", code: "INVALID" },
              ],
            },
          };
        else {
          let updated = destination.find((p) => p.id === input.id);
          if (!updated) {
            updated = {
              ...source.find((p) => p.handle === input.handle)!,
              id: `gid://shopify/Product/${1000 + destination.length}`,
            };
            destination.push(updated);
          }
          data = {
            productSet: {
              product: {
                ...updated,
                variants: { edges: [{ node: variant(updated) }] },
              },
              userErrors: [],
            },
          };
        }
      } else
        throw new Error(`Unhandled Shopify operation: ${query.slice(0, 90)}`);
      return new Response(JSON.stringify({ data }), { status: 200 });
    };
    const src = await db.connectedStore.create({
      data: {
        shopDomain: owner,
        ownerShop: owner,
        accessToken: "test",
        currencyCode: "USD",
        isBaseStore: true,
      },
    });
    const dst = await db.connectedStore.create({
      data: {
        shopDomain: destDomain,
        ownerShop: owner,
        accessToken: "test",
        currencyCode: "USD",
      },
    });
    for (const domain of [owner, destDomain])
      await db.session.create({
        data: {
          id: `offline_${domain}`,
          shop: domain,
          state: "test",
          accessToken: "test",
        },
      });
    const rule = await db.syncRule.create({
      data: {
        name: "Catalog integration",
        ownerShop: owner,
        sourceStoreId: src.id,
        destStoreId: dst.id,
        syncImages: false,
        syncInventory: false,
        syncMetafields: false,
        syncCollections: false,
        syncMode: "MANUAL",
      },
    });
    const wait = async (id: string) => {
      for (let i = 0; i < 500; i++) {
        const job = await db.catalogJob.findUniqueOrThrow({ where: { id } });
        if (job.status !== "RUNNING") return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Catalog job timed out");
    };
    try {
      const { getStoreCatalogCounts } = await import("../app/services/store-catalog.server");
      await db.syncRule.update({ where: { id: rule.id }, data: { isActive: false } });
      assert.equal(await db.syncRule.count({ where: { ownerShop: owner, isActive: true } }), 0);
      const independentSource = await getStoreCatalogCounts(owner, src.id);
      assert.equal(independentSource.counts.total, 27, "Source count is available without any active rule");
      assert.equal(independentSource.counts.UNLISTED, 7);
      assert.equal((await getStoreCatalogCounts(owner, dst.id)).counts.total, 3, "Destination count is available without any active rule");
      await assert.rejects(getStoreCatalogCounts("another-account.myshopify.com", src.id), /not found/);
      boundedCounts = true;
      assert.equal((await getStoreCatalogCounts(owner, src.id)).counts.total, 27, "Bounded counts fall back to a fully paginated exact count");
      boundedCounts = false;
      await db.syncRule.update({ where: { id: rule.id }, data: { isActive: true } });
      const { triggerManualSync } = await import("../app/services/sync-engine.server");
      const empty = await triggerManualSync(rule.id, []);
      assert.equal(empty.queued, 0, "An explicit empty selection must not fall back to the whole catalog");
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: empty.jobId } })).status, "COMPLETED");
      catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
      const compareId = await startCatalogJob(owner, rule.id, "COMPARE");
      await assert.rejects(
        startCatalogJob(owner, rule.id, "COMPARE"),
        /already running/,
      );
      releaseCatalog!();
      catalogGate = null;
      assert.equal((await wait(compareId)).status, "COMPLETED");
      let state = await latestCatalog(owner, rule.id);
      assert.equal(state.snapshot?.sourceCounts?.total, 27);
      assert.equal(state.snapshot?.sourceCounts?.UNLISTED, 7);
      assert.equal(state.snapshot?.destCounts?.total, 3);
      assert.equal(state.snapshot?.products.length, 27);
      await assert.rejects(
        latestCatalog("other-account.myshopify.com", rule.id),
        /not found/,
      );
      await assert.rejects(
        startCatalogJob("other-account.myshopify.com", rule.id, "MATCH"),
        /not found/,
      );

      const matchId = await startCatalogJob(owner, rule.id, "MATCH");
      assert.equal((await wait(matchId)).status, "COMPLETED");
      assert.equal(mutations, 0, "Matching must never send product mutations");
      assert.equal(
        await db.productMapping.count({
          where: { sourceStoreId: src.id, status: "MATCHED" },
        }),
        3,
      );
      assert.equal(
        await db.usageTracker.count({ where: { shopDomain: owner } }),
        0,
        "Matching must not increase billing usage",
      );
      await wait(await startCatalogJob(owner, rule.id, "MATCH"));
      assert.equal(
        await db.productMapping.count({ where: { sourceStoreId: src.id } }),
        3,
        "Matching is idempotent",
      );

      state = await latestCatalog(owner, rule.id);
      await assert.rejects(
        startCatalogJob(
          owner,
          rule.id,
          "SYNC",
          { ...DEFAULT_SELECTION, statuses: [] },
          state.snapshotId!,
        ),
        /No remaining/,
      );
      const selection = {
        ...DEFAULT_SELECTION,
        method: "TAGS" as const,
        tags: ["Sale"],
        statuses: ["ACTIVE" as const],
      };
      const syncId = await startCatalogJob(
        owner,
        rule.id,
        "SYNC",
        selection,
        state.snapshotId!,
      );
      assert.equal((await wait(syncId)).status, "COMPLETED");
      assert.equal(
        mutations,
        7,
        "Only active products tagged Sale should be written",
      );
      state = await latestCatalog(owner, rule.id);
      assert.equal(
        state.snapshot?.products.filter((p) => p.state === "SYNCED").length,
        7,
      );
      await assert.rejects(
        startCatalogJob(owner, rule.id, "SYNC", selection, state.snapshotId!),
        /No remaining/,
      );

      // A deleted destination product is re-matched to a replacement by exact handle.
      destination.splice(
        destination.findIndex((p) => p.handle === "product-1"),
        1,
      );
      destination.push({ ...source[0], id: "gid://shopify/Product/9999" });
      await wait(await startCatalogJob(owner, rule.id, "MATCH"));
      const repaired = await db.productMapping.findFirstOrThrow({
        where: { sourceStoreId: src.id, sourceProductGid: source[0].id },
      });
      assert.equal(repaired.destProductGid, "gid://shopify/Product/9999");
      assert.equal(repaired.status, "MATCHED");

      // Failure stays remaining and succeeds on retry.
      failedHandle = "product-2";
      state = await latestCatalog(owner, rule.id);
      const manual = {
        ...DEFAULT_SELECTION,
        method: "MANUAL" as const,
        productIds: [source[1].id],
      };
      assert.equal(
        (
          await wait(
            await startCatalogJob(
              owner,
              rule.id,
              "SYNC",
              manual,
              state.snapshotId!,
            ),
          )
        ).status,
        "COMPLETED_WITH_ERRORS",
      );
      state = await latestCatalog(owner, rule.id);
      assert.equal(
        state.snapshot?.products.find((p) => p.id === source[1].id)?.state,
        "FAILED",
      );
      failedHandle = null;
      assert.equal(
        (
          await wait(
            await startCatalogJob(
              owner,
              rule.id,
              "SYNC",
              manual,
              state.snapshotId!,
            ),
          )
        ).status,
        "COMPLETED",
      );

      // A preview cannot widen after a product changes status.
      state = await latestCatalog(owner, rule.id);
      const beforeChange = mutations;
      const oldStatusSelection = {
        ...DEFAULT_SELECTION,
        statuses: ["UNLISTED" as const],
        method: "MANUAL" as const,
        productIds: [source[2].id],
      };
      source[2].status = "DRAFT";
      const changed = await wait(
        await startCatalogJob(
          owner,
          rule.id,
          "SYNC",
          oldStatusSelection,
          state.snapshotId!,
        ),
      );
      assert.equal(changed.status, "COMPLETED");
      assert.equal((changed.result as { skipped: number }).skipped, 1);
      assert.equal(mutations, beforeChange);

      // An exact handle already claimed by another source must not be re-linked.
      destination.push({ ...source[3], id: "gid://shopify/Product/444" });
      await db.productMapping.create({
        data: {
          sourceStoreId: src.id,
          destStoreId: dst.id,
          sourceProductGid: "gid://shopify/Product/888",
          sourceHandle: "other-product",
          destProductGid: "gid://shopify/Product/444",
          status: "MATCHED",
        },
      });
      const conflict = await wait(
        await startCatalogJob(owner, rule.id, "MATCH"),
      );
      assert.equal(conflict.status, "COMPLETED_WITH_ERRORS");
      assert.match(JSON.stringify(conflict.result), /already linked/);
      assert.equal(
        await db.productMapping.count({
          where: { sourceStoreId: src.id, sourceProductGid: source[3].id },
        }),
        0,
      );
      assert.equal(mutations, beforeChange);

      // The existing plan limit remains enforced for newly created products.
      await db.usageTracker.upsert({
        where: { shopDomain: owner },
        update: { syncedProductCount: 50 },
        create: { shopDomain: owner, syncedProductCount: 50 },
      });
      state = await latestCatalog(owner, rule.id);
      const limited = await wait(
        await startCatalogJob(
          owner,
          rule.id,
          "SYNC",
          {
            ...DEFAULT_SELECTION,
            method: "MANUAL",
            productIds: [source[5].id],
          },
          state.snapshotId!,
        ),
      );
      assert.equal(limited.status, "COMPLETED_WITH_ERRORS");
      assert.match(JSON.stringify(limited.result), /Product limit reached/);
      assert.equal(mutations, beforeChange);

      const interrupted = await db.catalogJob.create({
        data: {
          ownerShop: owner,
          syncRuleId: rule.id,
          operation: "COMPARE",
          activePair: `${src.id}:${dst.id}`,
          updatedAt: new Date(Date.now() - 6 * 60_000),
        },
      });
      await latestCatalog(owner, rule.id);
      assert.equal(
        (
          await db.catalogJob.findUniqueOrThrow({
            where: { id: interrupted.id },
          })
        ).activePair,
        null,
      );

      destinationUnavailable = true;
      assert.equal(
        (await wait(await startCatalogJob(owner, rule.id, "COMPARE"))).status,
        "COMPLETED_WITH_ERRORS",
      );
      state = await latestCatalog(owner, rule.id);
      assert.equal(state.snapshot?.sourceCounts?.total, 27);
      assert.equal(state.snapshot?.destCounts, null);
      assert.match(state.snapshot?.destError || "", /Destination unavailable/);
    } finally {
      releaseCatalog?.();
      globalThis.fetch = originalFetch;
      await db.catalogJob.deleteMany({ where: { ownerShop: owner } });
      await db.syncJob.deleteMany({ where: { syncRuleId: rule.id } });
      await db.connectedStore.deleteMany({ where: { ownerShop: owner } });
      await db.session.deleteMany({
        where: { shop: { in: [owner, destDomain] } },
      });
      await db.usageTracker.deleteMany({ where: { shopDomain: owner } });
      await db.subscription.deleteMany({ where: { shopDomain: owner } });
      await db.$disconnect();
    }
  },
);
