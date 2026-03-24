import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Mandatory compliance webhook: shop/redact
 * Shopify sends this 48 hours after a store uninstalls the app.
 * We must delete all store data from our database.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  console.log(`[Webhook] shop/redact from ${shop}`);
  console.log(`[Webhook] Redacting all data for shop: ${payload.shop_domain}`);

  const shopDomain = payload.shop_domain || shop;

  try {
    // Find the store
    const store = await prisma.connectedStore.findUnique({
      where: { shopDomain },
    });

    if (store) {
      // Delete all related data in order (respecting foreign keys)
      await prisma.syncLog.deleteMany({
        where: { storeId: store.id },
      });

      await prisma.productMapping.deleteMany({
        where: {
          OR: [{ sourceStoreId: store.id }, { destStoreId: store.id }],
        },
      });

      await prisma.collectionMapping.deleteMany({
        where: {
          OR: [{ sourceStoreId: store.id }, { destStoreId: store.id }],
        },
      });

      await prisma.syncRule.deleteMany({
        where: {
          OR: [{ sourceStoreId: store.id }, { destStoreId: store.id }],
        },
      });

      await prisma.connectedStore.delete({
        where: { id: store.id },
      });

      console.log(`[Webhook] Deleted all data for store ${shopDomain}`);
    }

    // Also clean up billing and usage data
    await prisma.subscription.deleteMany({ where: { shopDomain } });
    await prisma.usageTracker.deleteMany({ where: { shopDomain } });
    await prisma.bulkOperationTracker.deleteMany({ where: { shopDomain } });

    // Delete sessions
    await prisma.session.deleteMany({ where: { shop: shopDomain } });

    console.log(`[Webhook] Shop redaction complete for ${shopDomain}`);
  } catch (error) {
    console.error(`[Webhook] Error during shop redaction:`, error);
  }

  return new Response(null, { status: 200 });
};
