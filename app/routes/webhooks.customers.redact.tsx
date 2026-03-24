import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: customers/redact
 * Shopify sends this when a store owner requests deletion of customer data.
 * Since this app doesn't store customer data, we acknowledge and return 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] customers/redact from ${shop}`);
  console.log(`[Webhook] Customer redact request for shop_id: ${payload.shop_id}`);

  // This app does not store customer personal data.
  // If it did, you would delete the customer's data here.

  return new Response(null, { status: 200 });
};
