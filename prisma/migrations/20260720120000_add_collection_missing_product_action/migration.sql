-- Collection-to-collection sync: let each CollectionMapping choose whether a
-- source product missing on the destination should be skipped or created,
-- and record which SyncRule governs the pairing (store pair + price rule +
-- product-status settings) for manual "Sync now" and on-the-fly creation.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "MissingProductAction" AS ENUM ('SKIP', 'CREATE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "syncRuleId" TEXT;
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "missingProductAction" "MissingProductAction" NOT NULL DEFAULT 'SKIP';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CollectionMapping_syncRuleId_idx" ON "CollectionMapping"("syncRuleId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "CollectionMapping" ADD CONSTRAINT "CollectionMapping_syncRuleId_fkey" FOREIGN KEY ("syncRuleId") REFERENCES "SyncRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
