import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleProductWebhook } from "../services/sync-engine.server";
import { isWebhookDuplicate, getWebhookId } from "../utils/webhook-dedup.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookId = getWebhookId(request);
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} from ${shop}`);

  // Deduplicate - skip if already processed
  if (webhookId && await isWebhookDuplicate(webhookId)) {
    console.log(`[Webhook] Duplicate ${topic} (${webhookId}), skipping`);
    return new Response(null, { status: 200 });
  }

  try {
    const productGid = payload.admin_graphql_api_id;
    if (productGid) {
      await handleProductWebhook(topic, shop, productGid);
    }
  } catch (error) {
    console.error(`[Webhook] Error processing ${topic}:`, error);
  }

  return new Response(null, { status: 200 });
};
