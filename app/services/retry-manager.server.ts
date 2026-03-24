import prisma from "../db.server";
import { createLogger } from "../utils/logger.server";
import { syncProductQueue, syncCollectionQueue, syncInventoryQueue } from "../jobs/queue.server";

const log = createLogger("RetryManager");

interface FailedSyncItem {
  id: string;
  syncRuleId: string | null;
  ruleName: string | null;
  resourceType: string;
  sourceGid: string | null;
  errorDetail: string | null;
  trigger: string;
  createdAt: string;
  retryCount: number;
}

/**
 * Get all failed sync logs eligible for retry.
 */
export async function getFailedSyncs(options?: {
  syncRuleId?: string;
  resourceType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: FailedSyncItem[]; total: number }> {
  const where: any = { status: "FAILED" };
  if (options?.syncRuleId) where.syncRuleId = options.syncRuleId;
  if (options?.resourceType) where.resourceType = options.resourceType;

  const [items, total] = await Promise.all([
    prisma.syncLog.findMany({
      where,
      include: {
        syncRule: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: options?.limit ?? 50,
      skip: options?.offset ?? 0,
    }),
    prisma.syncLog.count({ where }),
  ]);

  return {
    items: items.map((item) => ({
      id: item.id,
      syncRuleId: item.syncRuleId,
      ruleName: item.syncRule?.name ?? null,
      resourceType: item.resourceType,
      sourceGid: item.sourceGid,
      errorDetail: item.errorDetail,
      trigger: item.trigger,
      createdAt: item.createdAt.toISOString(),
      retryCount: 0,
    })),
    total,
  };
}

/**
 * Retry a specific failed sync log entry.
 */
export async function retrySyncItem(logId: string): Promise<{ success: boolean; error?: string }> {
  const logEntry = await prisma.syncLog.findUnique({
    where: { id: logId },
    include: { syncRule: true },
  });

  if (!logEntry) return { success: false, error: "Log entry not found" };
  if (logEntry.status !== "FAILED") return { success: false, error: "Only failed items can be retried" };
  if (!logEntry.syncRuleId) return { success: false, error: "No sync rule associated" };

  try {
    switch (logEntry.resourceType) {
      case "PRODUCT":
        if (!logEntry.sourceGid) return { success: false, error: "No source GID" };
        await syncProductQueue.add(`retry-${logEntry.id}`, {
          syncRuleId: logEntry.syncRuleId,
          sourceProductGid: logEntry.sourceGid,
          trigger: "RETRY",
        });
        break;

      case "COLLECTION":
        if (!logEntry.sourceGid) return { success: false, error: "No source GID" };
        await syncCollectionQueue.add(`retry-${logEntry.id}`, {
          syncRuleId: logEntry.syncRuleId,
          sourceCollectionGid: logEntry.sourceGid,
          trigger: "MANUAL",
        });
        break;

      case "INVENTORY":
        if (!logEntry.sourceGid) return { success: false, error: "No source GID" };
        await syncInventoryQueue.add(`retry-${logEntry.id}`, {
          syncRuleId: logEntry.syncRuleId,
          inventoryItemId: logEntry.sourceGid,
          locationId: "",
          available: 0,
        });
        break;

      default:
        return { success: false, error: `Unsupported resource type: ${logEntry.resourceType}` };
    }

    // Mark as retrying
    await prisma.syncLog.update({
      where: { id: logId },
      data: { status: "RETRYING" },
    });

    log.info(`Queued retry for ${logEntry.resourceType} ${logEntry.sourceGid}`);
    return { success: true };
  } catch (error) {
    log.error(`Failed to queue retry for ${logId}`, { error: (error as Error).message });
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Retry all failed syncs for a specific sync rule.
 */
export async function retryAllForRule(syncRuleId: string): Promise<{ queued: number; errors: number }> {
  const failedLogs = await prisma.syncLog.findMany({
    where: { syncRuleId, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  let queued = 0;
  let errors = 0;

  for (const entry of failedLogs) {
    const result = await retrySyncItem(entry.id);
    if (result.success) queued++;
    else errors++;
  }

  log.info(`Retry all for rule ${syncRuleId}: ${queued} queued, ${errors} errors`);
  return { queued, errors };
}

/**
 * Retry all failed syncs across all rules.
 */
export async function retryAllFailed(): Promise<{ queued: number; errors: number }> {
  const failedLogs = await prisma.syncLog.findMany({
    where: { status: "FAILED", syncRuleId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  let queued = 0;
  let errors = 0;

  for (const entry of failedLogs) {
    const result = await retrySyncItem(entry.id);
    if (result.success) queued++;
    else errors++;
  }

  return { queued, errors };
}

/**
 * Clean up old sync logs (older than N days).
 */
export async function cleanupOldLogs(daysToKeep: number = 30): Promise<number> {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

  const result = await prisma.syncLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  log.info(`Cleaned up ${result.count} logs older than ${daysToKeep} days`);
  return result.count;
}

/**
 * Get retry statistics.
 */
export async function getRetryStats(): Promise<{
  totalFailed: number;
  retrying: number;
  failedByType: Record<string, number>;
  failedByRule: Array<{ ruleId: string; ruleName: string; count: number }>;
}> {
  const [totalFailed, retrying, failedByType, failedByRule] = await Promise.all([
    prisma.syncLog.count({ where: { status: "FAILED" } }),
    prisma.syncLog.count({ where: { status: "RETRYING" } }),
    prisma.syncLog.groupBy({
      by: ["resourceType"],
      where: { status: "FAILED" },
      _count: true,
    }),
    prisma.syncLog.groupBy({
      by: ["syncRuleId"],
      where: { status: "FAILED", syncRuleId: { not: null } },
      _count: true,
      orderBy: { _count: { syncRuleId: "desc" } },
      take: 10,
    }),
  ]);

  // Fetch rule names
  const ruleIds = failedByRule.map((r) => r.syncRuleId).filter(Boolean) as string[];
  const rules = await prisma.syncRule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, name: true },
  });
  const ruleMap = new Map(rules.map((r) => [r.id, r.name]));

  return {
    totalFailed,
    retrying,
    failedByType: Object.fromEntries(
      failedByType.map((r) => [r.resourceType, r._count])
    ),
    failedByRule: failedByRule.map((r) => ({
      ruleId: r.syncRuleId || "",
      ruleName: ruleMap.get(r.syncRuleId || "") || "Unknown",
      count: r._count,
    })),
  };
}
