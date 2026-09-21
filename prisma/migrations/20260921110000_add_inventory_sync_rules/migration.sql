CREATE TYPE "InventorySyncDirection" AS ENUM ('ONE_WAY', 'TWO_WAY');

CREATE TABLE "InventorySyncRule" (
    "id" TEXT NOT NULL,
    "ownerShop" TEXT,
    "sourceStoreId" TEXT NOT NULL,
    "destStoreId" TEXT NOT NULL,
    "direction" "InventorySyncDirection" NOT NULL DEFAULT 'TWO_WAY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventorySyncRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySyncRule_sourceStoreId_destStoreId_key" ON "InventorySyncRule"("sourceStoreId", "destStoreId");
CREATE INDEX "InventorySyncRule_ownerShop_idx" ON "InventorySyncRule"("ownerShop");
CREATE INDEX "InventorySyncRule_isActive_idx" ON "InventorySyncRule"("isActive");

ALTER TABLE "InventorySyncRule" ADD CONSTRAINT "InventorySyncRule_sourceStoreId_fkey" FOREIGN KEY ("sourceStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventorySyncRule" ADD CONSTRAINT "InventorySyncRule_destStoreId_fkey" FOREIGN KEY ("destStoreId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
