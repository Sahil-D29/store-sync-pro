import prisma from "../db.server";
import { createLogger } from "../utils/logger.server";

const log = createLogger("ConflictResolution");

/**
 * Conflict resolution strategy: Source always wins (one-way sync).
 * This module handles edge cases around concurrent operations.
 */

/**
 * Acquire a sync lock for a product to prevent concurrent syncs.
 * Uses database-level advisory locking via a simple status flag.
 * Returns true if lock acquired, false if already locked.
 */
export async function acquireProductSyncLock(
  sourceProductGid: string,
  sourceStoreId: string,
  destStoreId: string
): Promise<boolean> {
  try {
    const mapping = await prisma.productMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceProductGid: {
          sourceStoreId,
          destStoreId,
          sourceProductGid,
        },
      },
    });

    if (!mapping) return true; // No mapping yet, safe to proceed

    // If mapping is in PENDING status, another sync might be in progress
    if (mapping.status === "PENDING") {
      // Check if it's been pending too long (stale lock - 5 minutes)
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (mapping.updatedAt > fiveMinAgo) {
        log.warn(`Product ${sourceProductGid} sync already in progress, skipping`);
        return false;
      }
      // Stale lock, can override
      log.info(`Overriding stale lock for ${sourceProductGid}`);
    }

    // Set to PENDING to indicate sync in progress
    await prisma.productMapping.update({
      where: { id: mapping.id },
      data: { status: "PENDING" },
    });

    return true;
  } catch (error) {
    log.error(`Error acquiring lock for ${sourceProductGid}`, {
      error: (error as Error).message,
    });
    return true; // Fail open - allow sync to proceed
  }
}

/**
 * Release sync lock by updating status to final state.
 */
export async function releaseProductSyncLock(
  sourceProductGid: string,
  sourceStoreId: string,
  destStoreId: string,
  status: "SYNCED" | "ERROR"
): Promise<void> {
  try {
    await prisma.productMapping.updateMany({
      where: {
        sourceStoreId,
        destStoreId,
        sourceProductGid,
      },
      data: { status },
    });
  } catch (error) {
    log.error(`Error releasing lock for ${sourceProductGid}`, {
      error: (error as Error).message,
    });
  }
}

/**
 * Acquire a collection sync lock.
 */
export async function acquireCollectionSyncLock(
  sourceCollectionGid: string,
  sourceStoreId: string,
  destStoreId: string
): Promise<boolean> {
  try {
    const mapping = await prisma.collectionMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceCollectionGid: {
          sourceStoreId,
          destStoreId,
          sourceCollectionGid,
        },
      },
    });

    if (!mapping) return true;

    if (mapping.status === "PENDING") {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (mapping.updatedAt > fiveMinAgo) {
        return false;
      }
    }

    await prisma.collectionMapping.update({
      where: { id: mapping.id },
      data: { status: "PENDING" },
    });

    return true;
  } catch {
    return true;
  }
}

/**
 * Detect if a product has diverged between source and destination.
 * This is informational only - source always wins in one-way sync.
 */
export async function detectDivergence(
  sourceProductGid: string,
  sourceStoreId: string,
  destStoreId: string,
  currentHash: string
): Promise<{ diverged: boolean; lastSyncHash?: string | null }> {
  const mapping = await prisma.productMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId,
        destStoreId,
        sourceProductGid,
      },
    },
  });

  if (!mapping) return { diverged: false };

  return {
    diverged: mapping.syncHash !== currentHash,
    lastSyncHash: mapping.syncHash,
  };
}
