-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('OAUTH', 'CUSTOM_TOKEN');
CREATE TYPE "StoreStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ERROR', 'DISCONNECTED');
CREATE TYPE "FilterType" AS ENUM ('ALL', 'SELECTED_COLLECTIONS', 'SELECTED_PRODUCTS', 'BY_TAGS');
CREATE TYPE "DestProductStatus" AS ENUM ('SAME_AS_SOURCE', 'ALWAYS_ACTIVE', 'ALWAYS_DRAFT');
CREATE TYPE "SyncMode" AS ENUM ('REALTIME', 'SCHEDULED', 'REALTIME_AND_SCHEDULED', 'MANUAL');
CREATE TYPE "ScheduleInterval" AS ENUM ('EVERY_5_MIN', 'EVERY_15_MIN', 'EVERY_30_MIN', 'HOURLY', 'EVERY_6_HOURS', 'DAILY');
CREATE TYPE "PriceRuleType" AS ENUM ('PERCENTAGE_MARKUP', 'PERCENTAGE_DISCOUNT', 'FIXED_MARKUP', 'FIXED_DISCOUNT', 'CURRENCY_CONVERSION');
CREATE TYPE "MappingStatus" AS ENUM ('PENDING', 'SYNCED', 'ERROR', 'SKIPPED');
CREATE TYPE "SyncAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'SKIP');
CREATE TYPE "ResourceType" AS ENUM ('PRODUCT', 'VARIANT', 'COLLECTION', 'INVENTORY', 'METAFIELD', 'IMAGE', 'SEO');
CREATE TYPE "LogStatus" AS ENUM ('SUCCESS', 'FAILED', 'PARTIAL', 'SKIPPED', 'RETRYING');
CREATE TYPE "SyncTrigger" AS ENUM ('WEBHOOK', 'SCHEDULED', 'MANUAL', 'BULK_OPERATION', 'RETRY');
CREATE TYPE "BillingPlan" AS ENUM ('FREE', 'BASIC', 'PRO', 'ENTERPRISE');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'FROZEN', 'TRIAL');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
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
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedStore" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "accessToken" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "isBaseStore" BOOLEAN NOT NULL DEFAULT false,
    "authMethod" "AuthMethod" NOT NULL DEFAULT 'OAUTH',
    "status" "StoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectedStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRule" (
    "id" TEXT NOT NULL,
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
    "filterType" "FilterType" NOT NULL DEFAULT 'ALL',
    "filterCollectionIds" TEXT,
    "filterProductIds" TEXT,
    "filterTags" TEXT,
    "destProductStatus" "DestProductStatus" NOT NULL DEFAULT 'SAME_AS_SOURCE',
    "syncMode" "SyncMode" NOT NULL DEFAULT 'REALTIME',
    "scheduleInterval" "ScheduleInterval",
    "cronExpression" TEXT,
    "priceRuleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PriceRuleType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "targetCurrency" TEXT NOT NULL DEFAULT 'USD',
    "roundTo" DOUBLE PRECISION DEFAULT 0.99,
    "applyToCompareAt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "sourceProductGid" TEXT NOT NULL,
    "destProductGid" TEXT,
    "sourceHandle" TEXT NOT NULL,
    "variantMappings" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncHash" TEXT,
    "status" "MappingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionMapping" (
    "id" TEXT NOT NULL,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "sourceCollectionGid" TEXT NOT NULL,
    "destCollectionGid" TEXT,
    "sourceHandle" TEXT NOT NULL,
    "destTitle" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "status" "MappingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CollectionMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "syncRuleId" TEXT,
    "storeId" TEXT,
    "action" "SyncAction" NOT NULL,
    "resourceType" "ResourceType" NOT NULL,
    "sourceGid" TEXT,
    "destGid" TEXT,
    "status" "LogStatus" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "message" TEXT,
    "errorDetail" TEXT,
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkOperationTracker" (
    "id" TEXT NOT NULL,
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
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "BulkOperationTracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "plan" "BillingPlan" NOT NULL DEFAULT 'FREE',
    "shopifyChargeGid" TEXT,
    "productLimit" INTEGER NOT NULL DEFAULT 100,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageTracker" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "syncedProductCount" INTEGER NOT NULL DEFAULT 0,
    "lastCountedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsageTracker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedStore_shopDomain_key" ON "ConnectedStore"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_sourceStoreId_destStoreId_sourceProductGid_key" ON "ProductMapping"("sourceStoreId", "destStoreId", "sourceProductGid");
CREATE INDEX "ProductMapping_sourceHandle_idx" ON "ProductMapping"("sourceHandle");
CREATE INDEX "ProductMapping_destProductGid_idx" ON "ProductMapping"("destProductGid");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMapping_sourceStoreId_destStoreId_sourceCollectionGid_key" ON "CollectionMapping"("sourceStoreId", "destStoreId", "sourceCollectionGid");

-- CreateIndex
CREATE INDEX "SyncLog_syncRuleId_createdAt_idx" ON "SyncLog"("syncRuleId", "createdAt");
CREATE INDEX "SyncLog_status_createdAt_idx" ON "SyncLog"("status", "createdAt");
CREATE INDEX "SyncLog_resourceType_createdAt_idx" ON "SyncLog"("resourceType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_fromCurrency_toCurrency_key" ON "ExchangeRate"("fromCurrency", "toCurrency");
CREATE INDEX "ExchangeRate_fetchedAt_idx" ON "ExchangeRate"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperationTracker_shopifyBulkOpGid_key" ON "BulkOperationTracker"("shopifyBulkOpGid");
CREATE INDEX "BulkOperationTracker_shopDomain_status_idx" ON "BulkOperationTracker"("shopDomain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopDomain_key" ON "Subscription"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "UsageTracker_shopDomain_key" ON "UsageTracker"("shopDomain");

-- AddForeignKey
ALTER TABLE "SyncRule" ADD CONSTRAINT "SyncRule_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRule" ADD CONSTRAINT "SyncRule_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRule" ADD CONSTRAINT "SyncRule_priceRuleId_fkey" FOREIGN KEY ("priceRuleId") REFERENCES "PriceRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CollectionMapping" ADD CONSTRAINT "CollectionMapping_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionMapping" ADD CONSTRAINT "CollectionMapping_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_syncRuleId_fkey" FOREIGN KEY ("syncRuleId") REFERENCES "SyncRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ConnectedStore"("id") ON DELETE SET NULL ON UPDATE CASCADE;
