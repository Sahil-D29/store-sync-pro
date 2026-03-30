-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SyncJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SyncJob" (
    "id" TEXT NOT NULL,
    "syncRuleId" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'RUNNING',
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "syncedProducts" INTEGER NOT NULL DEFAULT 0,
    "failedProducts" INTEGER NOT NULL DEFAULT 0,
    "skippedProducts" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT,
    "trigger" "SyncTrigger" NOT NULL DEFAULT 'MANUAL',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncJob_syncRuleId_startedAt_idx" ON "SyncJob"("syncRuleId", "startedAt");
