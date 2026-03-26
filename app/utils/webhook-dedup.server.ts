import redis from "../redis.server";

const DEDUP_PREFIX = "webhook:dedup:";
const DEDUP_TTL = 300; // 5 minutes - Shopify retries within this window

/**
 * Check if a webhook has already been processed using X-Shopify-Webhook-Id.
 * Returns true if this is a duplicate (already processed).
 */
export async function isWebhookDuplicate(webhookId: string): Promise<boolean> {
  if (!webhookId) return false;

  try {
    const key = `${DEDUP_PREFIX}${webhookId}`;
    // SET NX returns null if key already exists
    const result = await (redis as any).set(key, "1", "EX", DEDUP_TTL, "NX");
    // If result is null, the key already existed => duplicate
    return result === null;
  } catch (error) {
    // Redis not available - skip deduplication, allow webhook through
    console.warn("[WebhookDedup] Redis unavailable, skipping dedup check:", (error as Error).message);
    return false;
  }
}

/**
 * Extract webhook ID from request headers.
 * Shopify sends X-Shopify-Webhook-Id with every webhook.
 */
export function getWebhookId(request: Request): string | null {
  return request.headers.get("X-Shopify-Webhook-Id");
}
