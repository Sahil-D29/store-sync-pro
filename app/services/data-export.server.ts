import prisma from "../db.server";

/**
 * Export all sync data for backup/migration.
 */
export async function exportSyncData(): Promise<{
  exportedAt: string;
  stores: any[];
  syncRules: any[];
  priceRules: any[];
  productMappings: any[];
  collectionMappings: any[];
}> {
  const [stores, syncRules, priceRules, productMappings, collectionMappings] =
    await Promise.all([
      prisma.connectedStore.findMany({
        select: {
          id: true,
          shopDomain: true,
          shopName: true,
          currencyCode: true,
          isBaseStore: true,
          authMethod: true,
          status: true,
          lastSyncAt: true,
        },
      }),
      prisma.syncRule.findMany({
        include: {
          sourceStore: { select: { shopDomain: true } },
          destStore: { select: { shopDomain: true } },
          priceRule: { select: { name: true } },
        },
      }),
      prisma.priceRule.findMany(),
      prisma.productMapping.findMany({
        select: {
          sourceProductGid: true,
          destProductGid: true,
          sourceHandle: true,
          status: true,
          syncHash: true,
          lastSyncedAt: true,
          sourceStore: { select: { shopDomain: true } },
          destStore: { select: { shopDomain: true } },
        },
      }),
      prisma.collectionMapping.findMany({
        select: {
          sourceCollectionGid: true,
          destCollectionGid: true,
          sourceHandle: true,
          destTitle: true,
          status: true,
          lastSyncedAt: true,
          sourceStore: { select: { shopDomain: true } },
          destStore: { select: { shopDomain: true } },
        },
      }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    stores: stores.map((s) => ({
      ...s,
      lastSyncAt: s.lastSyncAt?.toISOString(),
    })),
    syncRules: syncRules.map((r) => ({
      id: r.id,
      name: r.name,
      sourceDomain: r.sourceStore.shopDomain,
      destDomain: r.destStore.shopDomain,
      priceRuleName: r.priceRule?.name,
      syncProducts: r.syncProducts,
      syncVariants: r.syncVariants,
      syncCollections: r.syncCollections,
      syncInventory: r.syncInventory,
      syncMetafields: r.syncMetafields,
      syncImages: r.syncImages,
      syncSeo: r.syncSeo,
      syncTags: r.syncTags,
      filterType: r.filterType,
      destProductStatus: r.destProductStatus,
      syncMode: r.syncMode,
      scheduleInterval: r.scheduleInterval,
      isActive: r.isActive,
    })),
    priceRules: priceRules.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
    productMappings: productMappings.map((m) => ({
      ...m,
      lastSyncedAt: m.lastSyncedAt?.toISOString(),
    })),
    collectionMappings: collectionMappings.map((m) => ({
      ...m,
      lastSyncedAt: m.lastSyncedAt?.toISOString(),
    })),
  };
}

/**
 * Export sync logs for a date range.
 */
export async function exportSyncLogs(options: {
  startDate?: string;
  endDate?: string;
  syncRuleId?: string;
  status?: string;
  limit?: number;
}): Promise<any[]> {
  const where: any = {};

  if (options.startDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(options.startDate) };
  }
  if (options.endDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(options.endDate) };
  }
  if (options.syncRuleId) where.syncRuleId = options.syncRuleId;
  if (options.status) where.status = options.status;

  const logs = await prisma.syncLog.findMany({
    where,
    include: {
      syncRule: { select: { name: true } },
      store: { select: { shopDomain: true } },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 10000,
  });

  return logs.map((l) => ({
    id: l.id,
    ruleName: l.syncRule?.name,
    storeDomain: l.store?.shopDomain,
    action: l.action,
    resourceType: l.resourceType,
    sourceGid: l.sourceGid,
    destGid: l.destGid,
    status: l.status,
    trigger: l.trigger,
    message: l.message,
    errorDetail: l.errorDetail,
    duration: l.duration,
    createdAt: l.createdAt.toISOString(),
  }));
}
