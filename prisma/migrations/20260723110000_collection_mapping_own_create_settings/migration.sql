-- Collection Mapping no longer depends on the SyncRule (full-catalog-sync)
-- concept at all. Drop syncRuleId and give each mapping its own price rule +
-- what-to-sync settings, used only when missingProductAction = CREATE, so
-- different destination stores can use different price rules.

-- DropForeignKey / DropIndex / DropColumn
ALTER TABLE "CollectionMapping" DROP CONSTRAINT IF EXISTS "CollectionMapping_syncRuleId_fkey";
DROP INDEX IF EXISTS "CollectionMapping_syncRuleId_idx";
ALTER TABLE "CollectionMapping" DROP COLUMN IF EXISTS "syncRuleId";

-- AlterTable
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createPriceRuleId" TEXT;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncVariants" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncImages" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncMetafields" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncSeo" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncTags" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createSyncInventory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "createDestProductStatus" "DestProductStatus" NOT NULL DEFAULT 'SAME_AS_SOURCE';

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "CollectionMapping" ADD CONSTRAINT "CollectionMapping_createPriceRuleId_fkey" FOREIGN KEY ("createPriceRuleId") REFERENCES "PriceRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
