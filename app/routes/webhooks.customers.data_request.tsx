import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: customers/data_request
 * Shopify sends this when a customer requests their data.
 * Since this app doesn't store customer data, we acknowledge and return 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] customers/data_request from ${shop}`);
  console.log(`[Webhook] Customer data request for shop_id: ${payload.shop_id}`);

  // This app does not store customer personal data.
  // If it did, you would collect and send the data to the store owner.

  return new Response(null, { status: 200 });
};
