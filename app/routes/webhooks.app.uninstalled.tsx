import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Mark the store as disconnected and deactivate all sync rules
  try {
    const store = await db.connectedStore.findUnique({
      where: { shopDomain: shop },
    });

    if (store) {
      // Deactivate all sync rules involving this store
      await db.syncRule.updateMany({
        where: {
          OR: [{ sourceStoreId: store.id }, { destStoreId: store.id }],
          isActive: true,
        },
        data: { isActive: false },
      });

      // Mark store as disconnected
      await db.connectedStore.update({
        where: { id: store.id },
        data: { status: "DISCONNECTED" },
      });

      console.log(`[Webhook] Store ${shop} marked as disconnected, sync rules deactivated`);
    }
  } catch (error) {
    console.error(`[Webhook] Error handling uninstall for ${shop}:`, error);
  }

  return new Response();
};
