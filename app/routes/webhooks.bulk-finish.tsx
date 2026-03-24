import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { processBulkResults } from "../services/bulk-operations.server";
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
    const bulkOpGid = payload.admin_graphql_api_id;
    if (!bulkOpGid) return new Response(null, { status: 200 });

    // Update tracker status
    await prisma.bulkOperationTracker.updateMany({
      where: { shopifyBulkOpGid: bulkOpGid },
      data: {
        status: payload.status || "COMPLETED",
        objectCount: payload.object_count,
        completedAt: new Date(),
      },
    });

    // If completed successfully, process the results
    if (payload.status === "completed") {
      const tracker = await prisma.bulkOperationTracker.findFirst({
        where: { shopifyBulkOpGid: bulkOpGid },
      });

      if (tracker?.syncRuleId && tracker.purpose === "BULK_PRODUCT_EXPORT") {
        // Fetch the result URL from Shopify
        const { createClientByDomain } = await import(
          "../services/shopify-client.server"
        );
        const client = await createClientByDomain(shop);
        const { checkBulkOperationStatus } = await import(
          "../services/bulk-operations.server"
        );

        const opStatus = await checkBulkOperationStatus(shop, bulkOpGid, client);

        if (opStatus.url) {
          console.log(`[Webhook] Processing bulk results from ${opStatus.url}`);
          const result = await processBulkResults(opStatus.url, tracker.syncRuleId);
          console.log(
            `[Webhook] Bulk results: ${result.processed} products queued, ${result.errors.length} errors`
          );
        }
      }
    }
  } catch (error) {
    console.error(`[Webhook] Error processing ${topic}:`, error);
  }

  return new Response(null, { status: 200 });
};
