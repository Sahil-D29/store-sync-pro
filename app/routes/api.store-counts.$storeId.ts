import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getAccountShop } from "../services/store-management.server";
import { getStoreCatalogCounts } from "../services/store-catalog.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const ownerShop = await getAccountShop(session.shop);
  const storeId = params.storeId || "";
  try {
    return json(await getStoreCatalogCounts(ownerShop, storeId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return json(
      { storeId, error: (error as Error).message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
