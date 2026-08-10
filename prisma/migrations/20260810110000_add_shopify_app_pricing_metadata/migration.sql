ALTER TABLE "Subscription" ADD COLUMN "shopifyShopGid" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "shopifyAppGid" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "planHandle" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
