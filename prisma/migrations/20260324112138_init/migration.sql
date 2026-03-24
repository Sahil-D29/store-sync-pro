-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "ConnectedStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "accessToken" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "isBaseStore" BOOLEAN NOT NULL DEFAULT false,
    "authMethod" TEXT NOT NULL DEFAULT 'OAUTH',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "syncProducts" BOOLEAN NOT NULL DEFAULT true,
    "syncVariants" BOOLEAN NOT NULL DEFAULT true,
    "syncCollections" BOOLEAN NOT NULL DEFAULT true,
    "syncInventory" BOOLEAN NOT NULL DEFAULT true,
    "syncMetafields" BOOLEAN NOT NULL DEFAULT true,
    "syncImages" BOOLEAN NOT NULL DEFAULT true,
    "syncSeo" BOOLEAN NOT NULL DEFAULT true,
    "syncTags" BOOLEAN NOT NULL DEFAULT true,
    "excludedFields" TEXT,
    "filterType" TEXT NOT NULL DEFAULT 'ALL',
    "filterCollectionIds" TEXT,
    "filterProductIds" TEXT,
    "filterTags" TEXT,
    "destProductStatus" TEXT NOT NULL DEFAULT 'SAME_AS_SOURCE',
    "syncMode" TEXT NOT NULL DEFAULT 'REALTIME',
    "scheduleInterval" TEXT,
    "cronExpression" TEXT,
    "priceRuleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncRule_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncRule_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncRule_priceRuleId_fkey" FOREIGN KEY ("priceRuleId") REFERENCES "PriceRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "targetCurrency" TEXT NOT NULL DEFAULT 'USD',
    "roundTo" REAL DEFAULT 0.99,
    "applyToCompareAt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "sourceProductGid" TEXT NOT NULL,
    "destProductGid" TEXT,
    "sourceHandle" TEXT NOT NULL,
    "variantMappings" TEXT,
    "lastSyncedAt" DATETIME,
    "syncHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductMapping_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductMapping_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CollectionMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "sourceCollectionGid" TEXT NOT NULL,
    "destCollectionGid" TEXT,
    "sourceHandle" TEXT NOT NULL,
    "destTitle" TEXT,
    "lastSyncedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CollectionMapping_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CollectionMapping_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "syncRuleId" TEXT,
    "storeId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "sourceGid" TEXT,
    "destGid" TEXT,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "message" TEXT,
    "errorDetail" TEXT,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncLog_syncRuleId_fkey" FOREIGN KEY ("syncRuleId") REFERENCES "SyncRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SyncLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ConnectedStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" REAL NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BulkOperationTracker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "shopifyBulkOpGid" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "syncRuleId" TEXT,
    "objectCount" INTEGER,
    "fileSize" INTEGER,
    "resultUrl" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "shopifyChargeGid" TEXT,
    "productLimit" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "trialEndsAt" DATETIME,
    "currentPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UsageTracker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "syncedProductCount" INTEGER NOT NULL DEFAULT 0,
    "lastCountedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedStore_shopDomain_key" ON "ConnectedStore"("shopDomain");

-- CreateIndex
CREATE INDEX "ProductMapping_sourceHandle_idx" ON "ProductMapping"("sourceHandle");

-- CreateIndex
CREATE INDEX "ProductMapping_destProductGid_idx" ON "ProductMapping"("destProductGid");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_sourceStoreId_destStoreId_sourceProductGid_key" ON "ProductMapping"("sourceStoreId", "destStoreId", "sourceProductGid");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMapping_sourceStoreId_destStoreId_sourceCollectionGid_key" ON "CollectionMapping"("sourceStoreId", "destStoreId", "sourceCollectionGid");

-- CreateIndex
CREATE INDEX "SyncLog_syncRuleId_createdAt_idx" ON "SyncLog"("syncRuleId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_status_createdAt_idx" ON "SyncLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_resourceType_createdAt_idx" ON "SyncLog"("resourceType", "createdAt");

-- CreateIndex
CREATE INDEX "ExchangeRate_fetchedAt_idx" ON "ExchangeRate"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_fromCurrency_toCurrency_key" ON "ExchangeRate"("fromCurrency", "toCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperationTracker_shopifyBulkOpGid_key" ON "BulkOperationTracker"("shopifyBulkOpGid");

-- CreateIndex
CREATE INDEX "BulkOperationTracker_shopDomain_status_idx" ON "BulkOperationTracker"("shopDomain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopDomain_key" ON "Subscription"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "UsageTracker_shopDomain_key" ON "UsageTracker"("shopDomain");
