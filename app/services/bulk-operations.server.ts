import prisma from "../db.server";
import { ShopifyGraphQLClient, createClientForStore } from "./shopify-client.server";
import { BULK_OPERATION_RUN_QUERY } from "../graphql/mutations";

interface BulkSyncResult {
  success: boolean;
  bulkOperationGid?: string;
  error?: string;
}

/**
 * Start a bulk product export from the source store.
 * This creates a Shopify bulk operation that exports all products to JSONL.
 * The result URL will be available via the bulk_operations/finish webhook.
 */
export async function startBulkProductExport(
  syncRuleId: string
): Promise<BulkSyncResult> {
  const rule = await prisma.syncRule.findUnique({
    where: { id: syncRuleId },
    include: { sourceStore: true },
  });

  if (!rule) return { success: false, error: "Sync rule not found" };

  const sourceClient = await createClientForStore(rule.sourceStoreId);

  // Build the bulk query
  const bulkQuery = `
    {
      products {
        edges {
          node {
            id
            title
            handle
            descriptionHtml
            vendor
            productType
            tags
            status
            seo {
              title
              description
            }
            options {
              name
              position
              values
            }
            variants {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  weight
                  weightUnit
                  inventoryQuantity
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
            metafields {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                }
              }
            }
            images {
              edges {
                node {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await sourceClient.queryWithRetry(BULK_OPERATION_RUN_QUERY, {
    query: bulkQuery,
  });

  if (result.data?.bulkOperationRunQuery?.userErrors?.length) {
    return {
      success: false,
      error: result.data.bulkOperationRunQuery.userErrors[0].message,
    };
  }

  const bulkOp = result.data?.bulkOperationRunQuery?.bulkOperation;
  if (!bulkOp) {
    return { success: false, error: "No bulk operation returned" };
  }

  // Track the operation
  await prisma.bulkOperationTracker.create({
    data: {
      shopDomain: rule.sourceStore.shopDomain,
      shopifyBulkOpGid: bulkOp.id,
      operationType: "QUERY",
      purpose: "BULK_PRODUCT_EXPORT",
      status: bulkOp.status,
      syncRuleId,
    },
  });

  return { success: true, bulkOperationGid: bulkOp.id };
}

/**
 * Check the status of a bulk operation
 */
export async function checkBulkOperationStatus(
  shopDomain: string,
  bulkOperationGid: string,
  sourceClient: ShopifyGraphQLClient
): Promise<{
  status: string;
  objectCount?: number;
  url?: string;
  errorCode?: string;
}> {
  const result = await sourceClient.queryWithRetry(
    `#graphql
    query BulkOperationStatus($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          status
          objectCount
          url
          errorCode
          fileSize
          partialDataUrl
        }
      }
    }`,
    { id: bulkOperationGid }
  );

  const node = result.data?.node;
  if (!node) {
    return { status: "UNKNOWN" };
  }

  // Update tracker
  await prisma.bulkOperationTracker.updateMany({
    where: { shopifyBulkOpGid: bulkOperationGid },
    data: {
      status: node.status,
      objectCount: node.objectCount,
      resultUrl: node.url,
      errorCode: node.errorCode,
      ...(node.status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });

  return {
    status: node.status,
    objectCount: node.objectCount,
    url: node.url,
    errorCode: node.errorCode,
  };
}

/**
 * Process bulk operation results from a JSONL URL.
 * Downloads and parses the JSONL file, then queues sync jobs for each product.
 */
export async function processBulkResults(
  resultUrl: string,
  syncRuleId: string
): Promise<{ processed: number; errors: string[] }> {
  const result = { processed: 0, errors: [] as string[] };

  try {
    const response = await fetch(resultUrl);
    if (!response.ok) {
      result.errors.push(`Failed to fetch results: ${response.status}`);
      return result;
    }

    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.trim());

    // Parse JSONL - each line is a JSON object
    // Parent objects have an "id" field, child objects have a "__parentId" field
    const products = new Map<string, any>();
    const children = new Map<string, any[]>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        if (obj.__parentId) {
          // Child object (variant, metafield, image)
          if (!children.has(obj.__parentId)) {
            children.set(obj.__parentId, []);
          }
          children.get(obj.__parentId)!.push(obj);
        } else if (obj.id) {
          // Parent product object
          products.set(obj.id, obj);
        }
      } catch {
        // Skip invalid lines
      }
    }

    // Queue sync for each product
    const { syncProductQueue } = await import("../jobs/queue.server");
    if (!syncProductQueue) {
      result.errors.push("Queue unavailable (Redis not connected)");
      return result;
    }

    for (const [productGid] of products) {
      try {
        await syncProductQueue.add(
          `bulk-${productGid}`,
          {
            syncRuleId,
            sourceProductGid: productGid,
            trigger: "BULK_OPERATION",
          },
          {
            // Deduplicate by product GID
            jobId: `bulk-${syncRuleId}-${productGid}`,
          }
        );
        result.processed++;
      } catch (error) {
        result.errors.push(
          `Failed to queue ${productGid}: ${(error as Error).message}`
        );
      }
    }
  } catch (error) {
    result.errors.push((error as Error).message);
  }

  return result;
}

/**
 * Get all bulk operations for a store
 */
export async function getBulkOperations(shopDomain?: string) {
  const where: any = {};
  if (shopDomain) where.shopDomain = shopDomain;

  return prisma.bulkOperationTracker.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: 50,
  });
}
