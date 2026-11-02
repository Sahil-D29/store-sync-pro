import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CatalogOverview } from "../app/components/CatalogOverview";

test("connected source and destination count cards render with zero sync rules", () => {
  const stores = [
    {
      id: "source",
      shopName: "Source catalog",
      shopDomain: "source.myshopify.com",
      isBaseStore: true,
    },
    {
      id: "destination",
      shopName: "Destination catalog",
      shopDomain: "destination.myshopify.com",
      isBaseStore: false,
    },
  ];
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <AppProvider i18n={en}>
          <CatalogOverview rules={[]} stores={stores} />
        </AppProvider>
      ),
    },
  ]);
  try {
    const view = renderToString(<RouterProvider router={router} />);
    for (const text of [
      "Source catalog",
      "Destination catalog",
      "Total products",
      "Active",
      "Draft",
      "Unlisted",
      "Archived",
      "Refresh all counts",
    ])
      assert.ok(
        view.includes(text),
        `Missing no-rule overview content: ${text}`,
      );
    assert.equal((view.match(/Total products/g) || []).length, 2);
    assert.ok(
      view.includes("Add missing products"),
      "Adding missing products must be available with zero sync rules",
    );
    assert.ok(
      view.includes("Source store") && view.includes("Destination store"),
      "A store pair can be selected directly on the homepage",
    );
    assert.ok(
      view.includes("Create sync rule"),
      "Ongoing sync configuration remains available separately",
    );
  } finally {
    router.dispose();
  }
});
