import prisma from "../db.server";

type AnalyticsScope = {
  ownerShop: string;
  currentStoreId?: string;
  currentStoreIsBase?: boolean;
};

const MISSING_STORE_ID = "__missing_store__";

function ruleWhere(scope: AnalyticsScope) {
  if (scope.currentStoreIsBase !== false) {
    return { ownerShop: scope.ownerShop };
  }

  const currentStoreId = scope.currentStoreId || MISSING_STORE_ID;
  return {
    ownerShop: scope.ownerShop,
    OR: [{ sourceStoreId: currentStoreId }, { destStoreId: currentStoreId }],
  };
}

function logWhere(scope: AnalyticsScope) {
  if (scope.currentStoreIsBase !== false) {
    return {
      OR: [
        { syncRule: { ownerShop: scope.ownerShop } },
        { AND: [{ syncRuleId: null }, { store: { ownerShop: scope.ownerShop } }] },
      ],
    };
  }

  const currentStoreId = scope.currentStoreId || MISSING_STORE_ID;
  return {
    OR: [
      {
        syncRule: {
          ownerShop: scope.ownerShop,
          OR: [
            { sourceStoreId: currentStoreId },
            { destStoreId: currentStoreId },
          ],
        },
      },
      { AND: [{ syncRuleId: null }, { storeId: currentStoreId }] },
    ],
  };
}

function storeWhere(scope: AnalyticsScope) {
  if (scope.currentStoreIsBase !== false) {
    return { ownerShop: scope.ownerShop, status: "ACTIVE" as const };
  }

  return {
    ownerShop: scope.ownerShop,
    status: "ACTIVE" as const,
    OR: [
      { shopDomain: scope.ownerShop },
      { id: scope.currentStoreId || MISSING_STORE_ID },
    ],
  };
}

function productMappingWhere(scope: AnalyticsScope) {
  if (scope.currentStoreIsBase !== false) {
    return {
      status: "SYNCED" as const,
      sourceStore: { ownerShop: scope.ownerShop },
    };
  }

  const currentStoreId = scope.currentStoreId || MISSING_STORE_ID;
  return {
    status: "SYNCED" as const,
    destStoreId: currentStoreId,
    sourceStore: { ownerShop: scope.ownerShop },
  };
}

function collectionMappingWhere(scope: AnalyticsScope) {
  if (scope.currentStoreIsBase !== false) {
    return {
      status: "SYNCED" as const,
      sourceStore: { ownerShop: scope.ownerShop },
    };
  }

  const currentStoreId = scope.currentStoreId || MISSING_STORE_ID;
  return {
    status: "SYNCED" as const,
    destStoreId: currentStoreId,
    sourceStore: { ownerShop: scope.ownerShop },
  };
}

/**
 * Get dashboard analytics data.
 */
export async function getDashboardAnalytics(scope: AnalyticsScope) {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const logsScope = logWhere(scope);

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
    prisma.connectedStore.count({
      where: storeWhere(scope),
    }),
    prisma.syncRule.count({ where: { ...ruleWhere(scope), isActive: true } }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "SUCCESS", createdAt: { gte: oneDayAgo } }] },
    }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "FAILED", createdAt: { gte: oneDayAgo } }] },
    }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "SUCCESS", createdAt: { gte: sevenDaysAgo } }] },
    }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "FAILED", createdAt: { gte: sevenDaysAgo } }] },
    }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "SUCCESS", createdAt: { gte: thirtyDaysAgo } }] },
    }),
    prisma.syncLog.count({
      where: { AND: [logsScope, { status: "FAILED", createdAt: { gte: thirtyDaysAgo } }] },
    }),
    prisma.productMapping.count({ where: productMappingWhere(scope) }),
    prisma.collectionMapping.count({ where: collectionMappingWhere(scope) }),
    prisma.syncLog.findMany({
      where: logsScope,
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        syncRule: { select: { name: true } },
        store: { select: { shopDomain: true, shopName: true } },
      },
    }),
    prisma.syncLog.groupBy({
      by: ["resourceType"],
      where: { AND: [logsScope, { createdAt: { gte: sevenDaysAgo } }] },
      _count: true,
    }),
    prisma.syncLog.groupBy({
      by: ["trigger"],
      where: { AND: [logsScope, { createdAt: { gte: sevenDaysAgo } }] },
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
export async function getDailySyncCounts(scope: AnalyticsScope, days: number = 7): Promise<Array<{
  date: string;
  success: number;
  failed: number;
}>> {
  const results: Array<{ date: string; success: number; failed: number }> = [];
  const logsScope = logWhere(scope);

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const [success, failed] = await Promise.all([
      prisma.syncLog.count({
        where: {
          AND: [
            logsScope,
            { status: "SUCCESS", createdAt: { gte: dayStart, lt: dayEnd } },
          ],
        },
      }),
      prisma.syncLog.count({
        where: {
          AND: [
            logsScope,
            { status: "FAILED", createdAt: { gte: dayStart, lt: dayEnd } },
          ],
        },
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
export async function getStoreSyncSummary(scope: AnalyticsScope) {
  const stores = await prisma.connectedStore.findMany({
    where: storeWhere(scope),
    orderBy: [{ isBaseStore: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      shopDomain: true,
      shopName: true,
      isBaseStore: true,
      lastSyncAt: true,
      _count: {
        select: {
          productMappingsAsSource: {
            where: {
              status: "SYNCED",
              sourceStore: { ownerShop: scope.ownerShop },
            },
          },
          productMappingsAsDest: {
            where: {
              status: "SYNCED",
              sourceStore: { ownerShop: scope.ownerShop },
            },
          },
          collectionMappingsAsSource: {
            where: {
              status: "SYNCED",
              sourceStore: { ownerShop: scope.ownerShop },
            },
          },
          collectionMappingsAsDest: {
            where: {
              status: "SYNCED",
              sourceStore: { ownerShop: scope.ownerShop },
            },
          },
          syncRulesAsSource: {
            where: { ownerShop: scope.ownerShop, isActive: true },
          },
          syncRulesAsDest: {
            where: { ownerShop: scope.ownerShop, isActive: true },
          },
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
