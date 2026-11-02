ALTER TYPE "MappingStatus" ADD VALUE IF NOT EXISTS 'MATCHED';

CREATE TABLE "CatalogJob" (
  "id" TEXT NOT NULL,
  "ownerShop" TEXT NOT NULL,
  "syncRuleId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "activePair" TEXT,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "total" INTEGER NOT NULL DEFAULT 0,
  "result" JSONB,
  "snapshot" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CatalogJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogJob_activePair_key" ON "CatalogJob"("activePair");
CREATE INDEX "CatalogJob_ownerShop_syncRuleId_startedAt_idx" ON "CatalogJob"("ownerShop", "syncRuleId", "startedAt");
