import prisma from "../db.server";
import { createClientForStore } from "./shopify-client.server";
import { syncCollection } from "./collection-sync.server";

const POLL_INTERVAL_MS = Number(process.env.COLLECTION_REALTIME_POLL_MS || 120_000);
const STALE_AFTER_MS = Number(process.env.COLLECTION_REALTIME_STALE_MS || 120_000);
const MAX_MAPPINGS_PER_TICK = Number(process.env.COLLECTION_REALTIME_POLL_LIMIT || 10);

declare global {
  // eslint-disable-next-line no-var
  var collectionRealtimePollerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var collectionRealtimePollerRunning: boolean | undefined;
}

export function startRealtimeCollectionPolling() {
  if (global.collectionRealtimePollerStarted) return;
  if (process.env.COLLECTION_REALTIME_POLLER_DISABLED === "true") return;

  global.collectionRealtimePollerStarted = true;

  const tick = () => {
    void syncStaleRealtimeCollections().catch((error) => {
      console.error("[CollectionRealtimePoller] Tick failed:", error);
    });
  };

  setInterval(tick, POLL_INTERVAL_MS);
  setTimeout(tick, 15_000);
  console.log(
    `[CollectionRealtimePoller] Started interval=${POLL_INTERVAL_MS}ms staleAfter=${STALE_AFTER_MS}ms limit=${MAX_MAPPINGS_PER_TICK}`
  );
}

async function syncStaleRealtimeCollections() {
  if (global.collectionRealtimePollerRunning) return;
  global.collectionRealtimePollerRunning = true;

  try {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
    const mappings = await prisma.collectionMapping.findMany({
      where: {
        triggerMode: "REALTIME",
        sourceStore: { status: "ACTIVE" },
        destStore: { status: "ACTIVE" },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
      },
      include: { sourceStore: true, destStore: true },
      orderBy: [{ lastSyncedAt: "asc" }, { updatedAt: "asc" }],
      take: MAX_MAPPINGS_PER_TICK,
    });

    for (const mapping of mappings) {
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
          trigger: "SCHEDULED",
          message: result.success
            ? "Realtime collection poll synced collection"
            : undefined,
          errorDetail: result.error,
          duration: result.duration,
        },
      });

      if (!result.success) {
        console.warn(
          `[CollectionRealtimePoller] Mapping ${mapping.id} failed: ${result.error || "Unknown error"}`
        );
      }
    }
  } finally {
    global.collectionRealtimePollerRunning = false;
  }
}
