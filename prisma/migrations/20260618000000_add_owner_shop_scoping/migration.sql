-- Per-merchant data scoping: an "account" = the base/source store's shopDomain.
-- ConnectedStore/SyncRule/PriceRule carry ownerShop directly. SyncLog and
-- CollectionMapping are scoped via their relations (sync rule / source store).

-- AlterTable: add nullable ownerShop columns
ALTER TABLE "ConnectedStore" ADD COLUMN IF NOT EXISTS "ownerShop" TEXT;
ALTER TABLE "SyncRule" ADD COLUMN IF NOT EXISTS "ownerShop" TEXT;
ALTER TABLE "PriceRule" ADD COLUMN IF NOT EXISTS "ownerShop" TEXT;

-- Backfill existing rows. The current data set has a single global base store,
-- so every existing row belongs to that one account.
DO $$
DECLARE
  base_shop TEXT;
BEGIN
  SELECT "shopDomain" INTO base_shop
  FROM "ConnectedStore"
  WHERE "isBaseStore" = true
  ORDER BY "createdAt" ASC
  LIMIT 1;

  IF base_shop IS NOT NULL THEN
    -- Base store owns itself
    UPDATE "ConnectedStore" SET "ownerShop" = "shopDomain"
      WHERE "isBaseStore" = true AND "ownerShop" IS NULL;
    -- Destinations and all config belong to the base store's account
    UPDATE "ConnectedStore" SET "ownerShop" = base_shop WHERE "ownerShop" IS NULL;
    UPDATE "SyncRule"  SET "ownerShop" = base_shop WHERE "ownerShop" IS NULL;
    UPDATE "PriceRule" SET "ownerShop" = base_shop WHERE "ownerShop" IS NULL;
  END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConnectedStore_ownerShop_idx" ON "ConnectedStore"("ownerShop");
CREATE INDEX IF NOT EXISTS "SyncRule_ownerShop_idx" ON "SyncRule"("ownerShop");
CREATE INDEX IF NOT EXISTS "PriceRule_ownerShop_idx" ON "PriceRule"("ownerShop");
