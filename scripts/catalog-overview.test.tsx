import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CatalogOverview } from "../app/components/CatalogOverview";

test("connected source and destination count cards render with zero sync rules", () => {
  const stores = [
    { id: "source", shopName: "Source catalog", shopDomain: "source.myshopify.com", isBaseStore: true },
    { id: "destination", shopName: "Destination catalog", shopDomain: "destination.myshopify.com", isBaseStore: false },
  ];
  const router = createMemoryRouter([{ path: "/", element: <AppProvider i18n={en}><CatalogOverview rules={[]} stores={stores} /></AppProvider> }]);
  try {
    const html = renderToString(<RouterProvider router={router} />);
    for (const text of ["Source catalog", "Destination catalog", "Total products", "Active", "Draft", "Unlisted", "Archived", "Refresh all counts"]) assert.ok(html.includes(text), `Missing no-rule overview content: ${text}`);
    assert.equal((html.match(/Total products/g) || []).length, 2);
    assert.ok(html.includes("Create sync rule"), "Rule creation is still offered for matching and sync");
  } finally { router.dispose(); }
});
