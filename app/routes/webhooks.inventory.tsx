import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleInventoryWebhook } from "../services/sync-engine.server";
import { isWebhookDuplicate, getWebhookId } from "../utils/webhook-dedup.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookId = getWebhookId(request);
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} from ${shop}`);

  if (webhookId && await isWebhookDuplicate(webhookId)) {
    console.log(`[Webhook] Duplicate ${topic} (${webhookId}), skipping`);
    return new Response(null, { status: 200 });
  }

  try {
    const inventoryItemId = payload.inventory_item_id
      ? `gid://shopify/InventoryItem/${payload.inventory_item_id}`
      : null;
    const locationId = payload.location_id
      ? `gid://shopify/Location/${payload.location_id}`
      : null;
    const available = payload.available ?? 0;

    if (inventoryItemId && locationId) {
      await handleInventoryWebhook(shop, inventoryItemId, locationId, available);
    }
  } catch (error) {
    console.error(`[Webhook] Error processing ${topic}:`, error);
  }

  return new Response(null, { status: 200 });
};
