import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAccountShop } from "../services/store-management.server";
import { createClientForStore } from "../services/shopify-client.server";
import { fetchAllCollections } from "../services/collection-sync.server";

/**
 * GET /api/store-collections/:storeId
 * List a connected store's collections, used to power the "link to an
 * existing destination collection" picker on the Collection Mapping page
 * (destination stores aren't the embedded admin session, so the App Bridge
 * resource picker can't be used against them).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || undefined;

  const { storeId } = params;
  if (!storeId) return json({ error: "Missing storeId" }, { status: 400 });

  const ownerShop = await getAccountShop(session.shop);

  const store = await prisma.connectedStore.findFirst({
    where: { id: storeId, ownerShop },
    select: { id: true },
  });

  if (!store) {
    return json({ error: "Store not found" }, { status: 404 });
  }

  try {
    const client = await createClientForStore(storeId);
    const collections = await fetchAllCollections(client, query);
    return json({ collections });
  } catch (error) {
    return json(
      { error: (error as Error).message, collections: [] },
      { status: 502 }
    );
  }
}
