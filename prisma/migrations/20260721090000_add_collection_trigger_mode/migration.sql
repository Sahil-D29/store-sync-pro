-- Per-collection sync trigger: let each CollectionMapping choose Live
-- (webhook-driven) vs Manual-only, independent of the store connection's
-- broader real-time setting.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CollectionSyncTrigger" AS ENUM ('REALTIME', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "CollectionMapping" ADD COLUMN IF NOT EXISTS "triggerMode" "CollectionSyncTrigger" NOT NULL DEFAULT 'REALTIME';
