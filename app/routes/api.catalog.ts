import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getAccountShop } from "../services/store-management.server";
import {
  latestCatalog,
  startCatalogJob,
  prepareMissingProducts,
} from "../services/catalog-reconciliation.server";
import { parseSelection, selectRemaining } from "../services/catalog-selection";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const ownerShop = await getAccountShop(session.shop);
  const ruleId = new URL(request.url).searchParams.get("ruleId") || "";
  try {
    const data = await latestCatalog(ownerShop, ruleId);
    const { products = [], ...summary } = data.snapshot || {};
    const collections = new Map(
      products.flatMap((p) => p.collections).map((c) => [c.id, c]),
    );
    return json(
      {
        ...data,
        ruleId,
        snapshot: data.snapshot
          ? {
              ...summary,
              eligible: products.length,
              synced: products.filter((p) => p.state === "SYNCED").length,
              matched: products.filter((p) => p.state === "MATCHED").length,
              unmatched: products.filter((p) => p.state === "UNMATCHED").length,
              failed: products.filter((p) => p.state === "FAILED").length,
              missing: products.filter((p) => p.existsInDestination === false)
                .length,
            }
          : null,
        collections: [...collections.values()].sort((a, b) =>
          a.title.localeCompare(b.title),
        ),
        tags: [...new Set(products.flatMap((p) => p.tags))].sort(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return json({ error: (error as Error).message, ruleId }, { status: 400 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const ownerShop = await getAccountShop(session.shop);
  let ruleId = "";
  let requestKey: string | undefined;
  try {
    const body = await request.json();
    ruleId = typeof body.ruleId === "string" ? body.ruleId : "";
    requestKey =
      typeof body.requestKey === "string" ? body.requestKey : undefined;
    if (body.intent === "PREPARE_MISSING") {
      const prepared = await prepareMissingProducts(
        ownerShop,
        typeof body.sourceStoreId === "string" ? body.sourceStoreId : "",
        typeof body.destStoreId === "string" ? body.destStoreId : "",
      );
      return json({ ...prepared, ruleId: prepared.rule.id });
    }
    if (body.intent === "preview") {
      const selection = parseSelection(body.selection);
      const data = await latestCatalog(ownerShop, ruleId);
      if (
        !data.snapshot ||
        data.snapshot.sourceError ||
        data.snapshot.destError
      )
        throw new Error("Refresh both catalogs before selecting products");
      const selected = selectRemaining(data.snapshot.products, selection);
      // Manual browsing lists remaining candidates without requiring prior selection.
      const candidates =
        body.browse === true
          ? selectRemaining(data.snapshot.products, {
              ...selection,
              method: "ALL",
            })
          : selected;
      const search =
        typeof body.search === "string" ? body.search.trim().toLowerCase() : "";
      const found = candidates.filter(
        (p) =>
          !search ||
          p.title.toLowerCase().includes(search) ||
          p.handle.toLowerCase().includes(search),
      );
      const pageCount = Math.max(1, Math.ceil(found.length / 20));
      const page = Math.min(
        pageCount,
        Math.max(1, Number.isSafeInteger(body.page) ? body.page : 1),
      );
      return json({
        ruleId,
        snapshotId: data.snapshotId,
        selectedCount: selected.length,
        count: found.length,
        page,
        pageCount,
        products: found.slice((page - 1) * 20, page * 20).map((p) => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          state: p.state,
        })),
        requestKey,
      });
    }
    if (!["COMPARE", "MATCH", "SYNC"].includes(body.intent))
      throw new Error("Unknown catalog action");
    const selection =
      body.intent === "SYNC" ? parseSelection(body.selection) : undefined;
    const jobId = await startCatalogJob(
      ownerShop,
      ruleId,
      body.intent,
      selection,
      typeof body.snapshotId === "string" ? body.snapshotId : undefined,
    );
    return json({ jobId, ruleId });
  } catch (error) {
    return json(
      { error: (error as Error).message, ruleId, requestKey },
      { status: 400 },
    );
  }
}
