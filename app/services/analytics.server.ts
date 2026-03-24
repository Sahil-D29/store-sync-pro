import prisma from "../db.server";

/**
 * Get dashboard analytics data.
 */
export async function getDashboardAnalytics(shopDomain?: string) {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalStores,
    activeRules,
    last24hSuccess,
    last24hFailed,
    last7dSuccess,
    last7dFailed,
    last30dSuccess,
    last30dFailed,
    totalProductMappings,
    totalCollectionMappings,
    recentActivity,
    syncsByResource,
    syncsByTrigger,
  ] = await Promise.all([
    prisma.connectedStore.count({ where: { status: "ACTIVE" } }),
    prisma.syncRule.count({ where: { isActive: true } }),
    prisma.syncLog.count({ where: { status: "SUCCESS", createdAt: { gte: oneDayAgo } } }),
    prisma.syncLog.count({ where: { status: "FAILED", createdAt: { gte: oneDayAgo } } }),
    prisma.syncLog.count({ where: { status: "SUCCESS", createdAt: { gte: sevenDaysAgo } } }),
    prisma.syncLog.count({ where: { status: "FAILED", createdAt: { gte: sevenDaysAgo } } }),
    prisma.syncLog.count({ where: { status: "SUCCESS", createdAt: { gte: thirtyDaysAgo } } }),
    prisma.syncLog.count({ where: { status: "FAILED", createdAt: { gte: thirtyDaysAgo } } }),
    prisma.productMapping.count({ where: { status: "SYNCED" } }),
    prisma.collectionMapping.count({ where: { status: "SYNCED" } }),
    prisma.syncLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        syncRule: { select: { name: true } },
        store: { select: { shopDomain: true, shopName: true } },
      },
    }),
    prisma.syncLog.groupBy({
      by: ["resourceType"],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: true,
    }),
    prisma.syncLog.groupBy({
      by: ["trigger"],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: true,
    }),
  ]);

  return {
    overview: {
      totalStores,
      activeRules,
      totalProductMappings,
      totalCollectionMappings,
    },
    last24h: {
      success: last24hSuccess,
      failed: last24hFailed,
      total: last24hSuccess + last24hFailed,
      successRate: last24hSuccess + last24hFailed > 0
        ? Math.round((last24hSuccess / (last24hSuccess + last24hFailed)) * 100)
        : 100,
    },
    last7d: {
      success: last7dSuccess,
      failed: last7dFailed,
      total: last7dSuccess + last7dFailed,
      successRate: last7dSuccess + last7dFailed > 0
        ? Math.round((last7dSuccess / (last7dSuccess + last7dFailed)) * 100)
        : 100,
    },
    last30d: {
      success: last30dSuccess,
      failed: last30dFailed,
      total: last30dSuccess + last30dFailed,
      successRate: last30dSuccess + last30dFailed > 0
        ? Math.round((last30dSuccess / (last30dSuccess + last30dFailed)) * 100)
        : 100,
    },
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      action: a.action,
      resourceType: a.resourceType,
      status: a.status,
      trigger: a.trigger,
      sourceGid: a.sourceGid,
      destGid: a.destGid,
      ruleName: a.syncRule?.name,
      storeName: a.store?.shopName || a.store?.shopDomain,
      duration: a.duration,
      errorDetail: a.errorDetail,
      createdAt: a.createdAt.toISOString(),
    })),
    syncsByResource: Object.fromEntries(
      syncsByResource.map((r) => [r.resourceType, r._count])
    ),
    syncsByTrigger: Object.fromEntries(
      syncsByTrigger.map((r) => [r.trigger, r._count])
    ),
  };
}

/**
 * Get sync performance metrics for a specific rule.
 */
export async function getRuleSyncMetrics(syncRuleId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalSyncs, successCount, failedCount, avgDuration, lastSync] = await Promise.all([
    prisma.syncLog.count({ where: { syncRuleId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.syncLog.count({ where: { syncRuleId, status: "SUCCESS", createdAt: { gte: sevenDaysAgo } } }),
    prisma.syncLog.count({ where: { syncRuleId, status: "FAILED", createdAt: { gte: sevenDaysAgo } } }),
    prisma.syncLog.aggregate({
      where: { syncRuleId, duration: { not: null }, createdAt: { gte: sevenDaysAgo } },
      _avg: { duration: true },
    }),
    prisma.syncLog.findFirst({
      where: { syncRuleId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    totalSyncs,
    successCount,
    failedCount,
    successRate: totalSyncs > 0 ? Math.round((successCount / totalSyncs) * 100) : 100,
    avgDuration: Math.round(avgDuration._avg.duration ?? 0),
    lastSyncAt: lastSync?.createdAt.toISOString() ?? null,
  };
}

/**
 * Get daily sync counts for charting (last N days).
 */
export async function getDailySyncCounts(days: number = 7): Promise<Array<{
  date: string;
  success: number;
  failed: number;
}>> {
  const results: Array<{ date: string; success: number; failed: number }> = [];

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const [success, failed] = await Promise.all([
      prisma.syncLog.count({
        where: { status: "SUCCESS", createdAt: { gte: dayStart, lt: dayEnd } },
      }),
      prisma.syncLog.count({
        where: { status: "FAILED", createdAt: { gte: dayStart, lt: dayEnd } },
      }),
    ]);

    results.push({
      date: dayStart.toISOString().split("T")[0],
      success,
      failed,
    });
  }

  return results;
}

/**
 * Get store-level sync summary.
 */
export async function getStoreSyncSummary() {
  const stores = await prisma.connectedStore.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      shopDomain: true,
      shopName: true,
      isBaseStore: true,
      lastSyncAt: true,
      _count: {
        select: {
          productMappingsAsSource: true,
          productMappingsAsDest: true,
          collectionMappingsAsSource: true,
          collectionMappingsAsDest: true,
          syncRulesAsSource: true,
          syncRulesAsDest: true,
        },
      },
    },
  });

  return stores.map((store) => ({
    id: store.id,
    shopDomain: store.shopDomain,
    shopName: store.shopName,
    isBaseStore: store.isBaseStore,
    lastSyncAt: store.lastSyncAt?.toISOString() ?? null,
    productMappings: store.isBaseStore
      ? store._count.productMappingsAsSource
      : store._count.productMappingsAsDest,
    collectionMappings: store.isBaseStore
      ? store._count.collectionMappingsAsSource
      : store._count.collectionMappingsAsDest,
    syncRules: store.isBaseStore
      ? store._count.syncRulesAsSource
      : store._count.syncRulesAsDest,
  }));
}
