-- Let a collection mapping link an already-existing destination product (by
-- handle) instead of creating a new one or skipping it.

-- AlterEnum
ALTER TYPE "MissingProductAction" ADD VALUE IF NOT EXISTS 'LINK_EXISTING';
