/**
 * Separate BullMQ worker process.
 * Run with: npx tsx worker.ts
 * On Fly.io: configured as a separate process group in fly.toml
 */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";

const redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const prisma = new PrismaClient();

console.log("[Worker] Starting BullMQ workers...");

// ===== SYNC PRODUCT WORKER =====
const syncProductWorker = new Worker(
  "sync-product",
  async (job) => {
    const { syncRuleId, sourceProductGid, trigger } = job.data;
    console.log(
      `[Worker] Processing product sync: ${sourceProductGid} (rule: ${syncRuleId})`
    );

    const { syncProduct } = await import(
      "./app/services/product-sync.server.js"
    );
    const { createClientForStore } = await import(
      "./app/services/shopify-client.server.js"
    );
    const { fetchResourceMetafields, syncMetafields } = await import(
      "./app/services/metafield-sync.server.js"
    );
    const { syncProductImages } = await import(
      "./app/services/media-sync.server.js"
    );
    const { syncProductInventory } = await import(
      "./app/services/inventory-sync.server.js"
    );

    const rule = await prisma.syncRule.findUnique({
      where: { id: syncRuleId },
      include: { sourceStore: true, destStore: true, priceRule: true },
    });

    if (!rule || !rule.isActive) {
      console.log(`[Worker] Rule ${syncRuleId} not found or inactive, skipping`);
      return;
    }

    const sourceClient = await createClientForStore(rule.sourceStoreId);
    const destClient = await createClientForStore(rule.destStoreId);

    const result = await syncProduct(rule, sourceProductGid, sourceClient, destClient);

    // Sync extras if product sync succeeded
    if (result.success && result.destGid) {
      // Metafields
      if (rule.syncMetafields) {
        try {
          const metafields = await fetchResourceMetafields(sourceProductGid, sourceClient);
          if (metafields.length > 0) {
            await syncMetafields(result.destGid, metafields, destClient, "PRODUCT");
          }
        } catch (err) {
          console.warn(`[Worker] Metafield sync warning: ${(err as Error).message}`);
        }
      }

      // Images
      if (rule.syncImages) {
        try {
          await syncProductImages(sourceProductGid, result.destGid, sourceClient, destClient);
        } catch (err) {
          console.warn(`[Worker] Image sync warning: ${(err as Error).message}`);
        }
      }

      // Inventory
      if (rule.syncInventory) {
        try {
          await syncProductInventory(rule, sourceProductGid, sourceClient, destClient);
        } catch (err) {
          console.warn(`[Worker] Inventory sync warning: ${(err as Error).message}`);
        }
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
        trigger,
        errorDetail: result.error,
        duration: result.duration,
      },
    });

    if (!result.success) {
      throw new Error(result.error || "Sync failed");
    }
  },
  {
    connection: redis as any,
    concurrency: 5,
    limiter: { max: 10, duration: 1000 },
  }
);

// ===== SYNC COLLECTION WORKER =====
// Collection Mapping is self-contained (no SyncRule involved) — a mapping
// always exists before anything about it syncs, so this just loads it
// directly instead of resolving a SyncRule first.
const syncCollectionWorker = new Worker(
  "sync-collection",
  async (job) => {
    const { collectionMappingId, trigger } = job.data;
    console.log(`[Worker] Processing collection sync: mapping ${collectionMappingId}`);

    const { syncCollection } = await import(
      "./app/services/collection-sync.server.js"
    );
    const { createClientForStore } = await import(
      "./app/services/shopify-client.server.js"
    );

    const mapping = await prisma.collectionMapping.findUnique({
      where: { id: collectionMappingId },
      include: { sourceStore: true, destStore: true },
    });

    if (!mapping) {
      console.log(`[Worker] Collection mapping ${collectionMappingId} not found, skipping`);
      return;
    }

    const sourceClient = await createClientForStore(mapping.sourceStoreId);
    const destClient = await createClientForStore(mapping.destStoreId);

    const result = await syncCollection(mapping, sourceClient, destClient);

    await prisma.syncLog.create({
      data: {
        storeId: mapping.destStoreId,
        action: result.action,
        resourceType: "COLLECTION",
        sourceGid: result.sourceGid,
        destGid: result.destGid,
        status: result.success ? "SUCCESS" : "FAILED",
        trigger,
        errorDetail: result.error,
        duration: result.duration,
      },
    });

    if (!result.success) {
      throw new Error(result.error || "Collection sync failed");
    }
  },
  {
    connection: redis as any,
    concurrency: 3,
    limiter: { max: 5, duration: 1000 },
  }
);

// ===== SYNC INVENTORY WORKER =====
const syncInventoryWorker = new Worker(
  "sync-inventory",
  async (job) => {
    const { syncRuleId, inventoryItemId, available } = job.data;
    console.log(
      `[Worker] Processing inventory sync: ${inventoryItemId} (rule: ${syncRuleId})`
    );

    const { syncInventoryItem } = await import(
      "./app/services/inventory-sync.server.js"
    );
    const { createClientForStore } = await import(
      "./app/services/shopify-client.server.js"
    );

    const rule = await prisma.syncRule.findUnique({
      where: { id: syncRuleId },
      include: { sourceStore: true, destStore: true, priceRule: true },
    });

    if (!rule || !rule.isActive) return;

    const destClient = await createClientForStore(rule.destStoreId);

    const result = await syncInventoryItem(rule, inventoryItemId, available, destClient);

    await prisma.syncLog.create({
      data: {
        syncRuleId: rule.id,
        storeId: rule.destStoreId,
        action: result.action,
        resourceType: "INVENTORY",
        sourceGid: result.sourceGid,
        status: result.success ? "SUCCESS" : "FAILED",
        trigger: "WEBHOOK",
        errorDetail: result.error,
        duration: result.duration,
      },
    });
  },
  {
    connection: redis as any,
    concurrency: 10,
    limiter: { max: 20, duration: 1000 },
  }
);

// ===== SCHEDULED SYNC WORKER =====
const scheduledSyncWorker = new Worker(
  "scheduled-sync",
  async (job) => {
    const { syncRuleId } = job.data;
    console.log(`[Worker] Running scheduled sync for rule: ${syncRuleId}`);

    const { triggerManualSync } = await import(
      "./app/services/sync-engine.server.js"
    );

    const result = await triggerManualSync(syncRuleId);
    console.log(
      `[Worker] Scheduled sync complete: ${result.queued} synced, ${result.errors.length} errors`
    );
  },
  {
    connection: redis as any,
    concurrency: 2,
  }
);

// ===== BULK SYNC WORKER =====
const bulkSyncWorker = new Worker(
  "bulk-sync",
  async (job) => {
    const { syncRuleId } = job.data;
    console.log(`[Worker] Running bulk sync for rule: ${syncRuleId}`);

    const { triggerManualSync } = await import(
      "./app/services/sync-engine.server.js"
    );

    const result = await triggerManualSync(syncRuleId);
    console.log(
      `[Worker] Bulk sync complete: ${result.queued} synced, ${result.errors.length} errors`
    );
  },
  {
    connection: redis as any,
    concurrency: 1,
  }
);

// ===== ERROR HANDLING =====
syncProductWorker.on("failed", (job, err) => {
  console.error(`[Worker] sync-product job ${job?.id} failed:`, err.message);
});

syncCollectionWorker.on("failed", (job, err) => {
  console.error(`[Worker] sync-collection job ${job?.id} failed:`, err.message);
});

syncInventoryWorker.on("failed", (job, err) => {
  console.error(`[Worker] sync-inventory job ${job?.id} failed:`, err.message);
});

scheduledSyncWorker.on("failed", (job, err) => {
  console.error(`[Worker] scheduled-sync job ${job?.id} failed:`, err.message);
});

bulkSyncWorker.on("failed", (job, err) => {
  console.error(`[Worker] bulk-sync job ${job?.id} failed:`, err.message);
});

// ===== GRACEFUL SHUTDOWN =====
async function shutdown() {
  console.log("[Worker] Shutting down...");
  await syncProductWorker.close();
  await syncCollectionWorker.close();
  await syncInventoryWorker.close();
  await scheduledSyncWorker.close();
  await bulkSyncWorker.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[Worker] All workers started and listening for jobs.");
