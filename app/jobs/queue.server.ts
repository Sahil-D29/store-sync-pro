import { Queue, Worker, type Job } from "bullmq";
import redis, { isRedisAvailable } from "../redis.server";

// ===== QUEUE DEFINITIONS =====

function createQueue(name: string, opts: any): Queue | null {
  try {
    const queue = new Queue(name, {
      connection: redis as any,
      defaultJobOptions: opts,
    });
    // Prevent unhandled 'error' events from crashing the process
    queue.on("error", (err) => {
      console.warn(`[Queue:${name}] Error:`, err.message);
    });
    return queue;
  } catch (err) {
    console.warn(`[Queue] Failed to create queue ${name}:`, (err as Error).message);
    return null;
  }
}

export const syncProductQueue = createQueue("sync-product", {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
});

export const syncCollectionQueue = createQueue("sync-collection", {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 2000 },
});

export const syncInventoryQueue = createQueue("sync-inventory", {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 2000 },
  removeOnFail: { count: 5000 },
});

export const bulkSyncQueue = createQueue("bulk-sync", {
  attempts: 2,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

export const scheduledSyncQueue = createQueue("scheduled-sync", {
  attempts: 2,
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
});

// ===== JOB DATA TYPES =====

export interface SyncProductJobData {
  syncRuleId: string;
  sourceProductGid: string;
  trigger: "WEBHOOK" | "SCHEDULED" | "MANUAL" | "BULK_OPERATION";
}

export interface SyncCollectionJobData {
  collectionMappingId: string;
  trigger: "WEBHOOK" | "SCHEDULED" | "MANUAL";
}

export interface SyncInventoryJobData {
  syncRuleId: string;
  inventoryItemId: string;
  locationId: string;
  available: number;
}

export interface BulkSyncJobData {
  syncRuleId: string;
}

export interface ScheduledSyncJobData {
  syncRuleId: string;
}

// ===== HELPER: Schedule interval to cron =====

export function intervalToCron(interval: string): string {
  switch (interval) {
    case "EVERY_5_MIN":
      return "*/5 * * * *";
    case "EVERY_15_MIN":
      return "*/15 * * * *";
    case "EVERY_30_MIN":
      return "*/30 * * * *";
    case "HOURLY":
      return "0 * * * *";
    case "EVERY_6_HOURS":
      return "0 */6 * * *";
    case "DAILY":
      return "0 0 * * *";
    default:
      return "0 * * * *"; // default hourly
  }
}

/**
 * Add or update a scheduled sync job for a sync rule
 */
export async function setupScheduledSync(
  syncRuleId: string,
  interval: string
): Promise<void> {
  if (!scheduledSyncQueue || !isRedisAvailable()) {
    console.warn("[Queue] Redis unavailable, scheduled sync not configured");
    return;
  }
  try {
    const repeatableJobs = await scheduledSyncQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      if (job.name === `scheduled-${syncRuleId}`) {
        await scheduledSyncQueue.removeRepeatableByKey(job.key);
      }
    }

    await scheduledSyncQueue.add(
      `scheduled-${syncRuleId}`,
      { syncRuleId } as ScheduledSyncJobData,
      {
        repeat: { pattern: intervalToCron(interval) },
      }
    );
  } catch (error) {
    console.warn("[Queue] Redis unavailable, scheduled sync not configured:", (error as Error).message);
  }
}

/**
 * Remove scheduled sync for a sync rule
 */
export async function removeScheduledSync(syncRuleId: string): Promise<void> {
  if (!scheduledSyncQueue || !isRedisAvailable()) {
    console.warn("[Queue] Redis unavailable, could not remove scheduled sync");
    return;
  }
  try {
    const repeatableJobs = await scheduledSyncQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      if (job.name === `scheduled-${syncRuleId}`) {
        await scheduledSyncQueue.removeRepeatableByKey(job.key);
      }
    }
  } catch (error) {
    console.warn("[Queue] Redis unavailable, could not remove scheduled sync:", (error as Error).message);
  }
}
