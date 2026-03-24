import { ShopifyGraphQLClient, createClientForStore } from "./shopify-client.server";
import { WEBHOOK_SUBSCRIPTION_CREATE_MUTATION } from "../graphql/mutations";
import { createLogger } from "../utils/logger.server";

const log = createLogger("WebhookRegistration");

interface WebhookRegistrationResult {
  topic: string;
  success: boolean;
  error?: string;
}

/**
 * Topics that should be registered on destination stores.
 * Destination stores don't need product/collection webhooks (source-only),
 * but we listen for app/uninstalled to clean up.
 */
const DESTINATION_WEBHOOK_TOPICS = [
  "APP_UNINSTALLED",
] as const;

/**
 * Topics registered on the source store (handled by shopify.app.toml for the main store,
 * but destination stores connected via token need manual registration).
 */
const SOURCE_WEBHOOK_TOPICS = [
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "COLLECTIONS_CREATE",
  "COLLECTIONS_UPDATE",
  "COLLECTIONS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
  "BULK_OPERATIONS_FINISH",
] as const;

/**
 * Register required webhooks on a store.
 */
export async function registerWebhooksForStore(
  storeId: string,
  appUrl: string,
  isSource: boolean = false
): Promise<WebhookRegistrationResult[]> {
  const client = await createClientForStore(storeId);
  const topics = isSource ? SOURCE_WEBHOOK_TOPICS : DESTINATION_WEBHOOK_TOPICS;
  const results: WebhookRegistrationResult[] = [];

  for (const topic of topics) {
    try {
      const callbackUrl = `${appUrl}/webhooks/${topicToPath(topic)}`;

      const result = await client.queryWithRetry(
        WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
        {
          topic,
          webhookSubscription: {
            callbackUrl,
            format: "JSON",
          },
        }
      );

      const userErrors = result.data?.webhookSubscriptionCreate?.userErrors;
      if (userErrors?.length) {
        // "already exists" errors are fine
        const isAlreadyRegistered = userErrors.some(
          (e: any) => e.message?.includes("already been taken") || e.message?.includes("already exists")
        );
        if (isAlreadyRegistered) {
          results.push({ topic, success: true });
        } else {
          results.push({ topic, success: false, error: userErrors[0].message });
          log.warn(`Failed to register webhook ${topic}`, { error: userErrors[0].message });
        }
      } else {
        results.push({ topic, success: true });
        log.info(`Registered webhook ${topic}`);
      }
    } catch (error) {
      results.push({ topic, success: false, error: (error as Error).message });
      log.error(`Error registering webhook ${topic}`, { error: (error as Error).message });
    }
  }

  return results;
}

/**
 * Check webhook health - verify registered webhooks match expected topics.
 */
export async function checkWebhookHealth(
  storeId: string
): Promise<{ healthy: boolean; registered: string[]; missing: string[] }> {
  const client = await createClientForStore(storeId);

  const result = await client.queryWithRetry(
    `#graphql
    query WebhookSubscriptions {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            endpoint {
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
        }
      }
    }`
  );

  const registeredTopics = result.data?.webhookSubscriptions?.edges?.map(
    (e: any) => e.node.topic
  ) || [];

  const expectedTopics = [...SOURCE_WEBHOOK_TOPICS];
  const missing = expectedTopics.filter((t) => !registeredTopics.includes(t));

  return {
    healthy: missing.length === 0,
    registered: registeredTopics,
    missing,
  };
}

/**
 * Convert webhook topic to URL path.
 */
function topicToPath(topic: string): string {
  // PRODUCTS_CREATE -> products
  // COLLECTIONS_UPDATE -> collections
  // INVENTORY_LEVELS_UPDATE -> inventory
  // BULK_OPERATIONS_FINISH -> bulk-finish
  const mapping: Record<string, string> = {
    PRODUCTS_CREATE: "products",
    PRODUCTS_UPDATE: "products",
    PRODUCTS_DELETE: "products",
    COLLECTIONS_CREATE: "collections",
    COLLECTIONS_UPDATE: "collections",
    COLLECTIONS_DELETE: "collections",
    INVENTORY_LEVELS_UPDATE: "inventory",
    BULK_OPERATIONS_FINISH: "bulk-finish",
    APP_UNINSTALLED: "app/uninstalled",
  };
  return mapping[topic] || topic.toLowerCase().replace(/_/g, "-");
}
