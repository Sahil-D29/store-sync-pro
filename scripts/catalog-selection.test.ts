import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SELECTION,
  matchVariants,
  matchesCatalogRule,
  parseSelection,
  selectRemaining,
} from "../app/services/catalog-selection";
import type {
  CatalogSelection,
  CatalogVariant,
  RemainingProduct,
} from "../app/services/catalog-selection";

const products: RemainingProduct[] = [
  {
    id: "gid://shopify/Product/1",
    title: "Active",
    handle: "active",
    status: "ACTIVE",
    tags: ["Summer", "Sale"],
    collections: [
      { id: "gid://shopify/Collection/1", title: "Summer" },
      { id: "gid://shopify/Collection/2", title: "Sale" },
    ],
    state: "UNMATCHED",
    destId: null,
  },
  {
    id: "gid://shopify/Product/2",
    title: "Draft",
    handle: "draft",
    status: "DRAFT",
    tags: ["Summer"],
    collections: [{ id: "gid://shopify/Collection/1", title: "Summer" }],
    state: "MATCHED",
    destId: "dest-2",
  },
  {
    id: "gid://shopify/Product/3",
    title: "Unlisted",
    handle: "unlisted",
    status: "UNLISTED",
    tags: ["Sale"],
    collections: [],
    state: "FAILED",
    destId: "dest-3",
  },
  {
    id: "gid://shopify/Product/4",
    title: "Archived",
    handle: "archived",
    status: "ARCHIVED",
    tags: [],
    collections: [],
    state: "UNMATCHED",
    destId: null,
  },
  {
    id: "gid://shopify/Product/5",
    title: "Synced",
    handle: "synced",
    status: "ACTIVE",
    tags: ["Summer"],
    collections: [],
    state: "SYNCED",
    destId: "dest-5",
  },
];
const choose = (patch: Partial<CatalogSelection>) =>
  selectRemaining(products, { ...DEFAULT_SELECTION, ...patch }).map((p) =>
    p.id.split("/").at(-1),
  );
test("missing-only selection excludes unmapped products whose handles already exist in destination", () => {
  const candidates = products.map((p, index) => ({
    ...p,
    existsInDestination: index !== 0,
  }));
  assert.deepEqual(
    selectRemaining(candidates, {
      ...DEFAULT_SELECTION,
      missingOnly: true,
    }).map((p) => p.handle),
    ["active"],
  );
  assert.deepEqual(
    selectRemaining(products, { ...DEFAULT_SELECTION, missingOnly: true }),
    [],
    "Older snapshots without existence checks cannot copy existing products",
  );
});
test("all statuses include matched and failed products, excluding completed syncs", () =>
  assert.deepEqual(choose({}), ["1", "2", "3", "4"]));
test("status selection narrows the remaining set", () =>
  assert.deepEqual(choose({ statuses: ["ACTIVE", "UNLISTED"] }), ["1", "3"]));
test("collections combine with status, deduplicating overlapping membership", () =>
  assert.deepEqual(
    choose({
      method: "COLLECTIONS",
      collectionIds: [
        "gid://shopify/Collection/1",
        "gid://shopify/Collection/2",
      ],
      statuses: ["ACTIVE"],
    }),
    ["1"],
  ));
test("any tags combine with status and compare case-insensitively", () =>
  assert.deepEqual(
    choose({
      method: "TAGS",
      tags: ["summer", "sale"],
      statuses: ["DRAFT", "UNLISTED"],
    }),
    ["2", "3"],
  ));
test("all tags require every selected tag", () =>
  assert.deepEqual(
    choose({ method: "TAGS", tags: ["summer", "sale"], tagMode: "ALL" }),
    ["1"],
  ));
test("manual IDs cannot select synced products or bypass status", () =>
  assert.deepEqual(
    choose({
      method: "MANUAL",
      productIds: products.map((p) => p.id),
      statuses: ["DRAFT"],
    }),
    ["2"],
  ));
test("empty statuses or collection/tag/manual selections never select all", () => {
  for (const patch of [
    { statuses: [] },
    { method: "COLLECTIONS" },
    { method: "TAGS" },
    { method: "MANUAL" },
  ] as Partial<CatalogSelection>[])
    assert.deepEqual(choose(patch), []);
});
test("saved rule eligibility cannot be widened by temporary filters", () => {
  const rule = {
    filterType: "SELECTED_COLLECTIONS",
    filterCollectionIds: JSON.stringify(["gid://shopify/Collection/2"]),
    filterProductIds: null,
    filterTags: null,
  };
  assert.deepEqual(
    selectRemaining(
      products.filter((p) => matchesCatalogRule(p, rule)),
      DEFAULT_SELECTION,
    ).map((p) => p.handle),
    ["active"],
  );
  assert.equal(
    matchesCatalogRule(products[0], { ...rule, filterCollectionIds: "[]" }),
    false,
  );
  assert.equal(
    matchesCatalogRule(products[0], {
      ...rule,
      filterType: "BY_TAGS",
      filterTags: "summer",
    }),
    true,
  );
});
test("untrusted filter enums and IDs are rejected; repeated IDs are deduplicated", () => {
  for (const patch of [
    { statuses: ["PUBLISHED"] },
    { method: "INVALID" },
    { tagMode: "INVALID" },
    { productIds: ["another-store"] },
    { collectionIds: ["gid://shopify/Product/1"] },
    { tags: [null] },
  ])
    assert.throws(() => parseSelection({ ...DEFAULT_SELECTION, ...patch }));
  assert.equal(
    parseSelection({
      ...DEFAULT_SELECTION,
      productIds: [products[0].id, products[0].id],
    }).productIds.length,
    1,
  );
});
const variant = (id: string, size: string): CatalogVariant => ({
  id,
  sku: id,
  selectedOptions: [{ name: "Size", value: size }],
});
test("variant mapping follows option combinations instead of array order", () => {
  assert.deepEqual(
    matchVariants(
      [variant("s1", "S"), variant("s2", "M")],
      [variant("d2", "M"), variant("d1", "S")],
    )?.map((v) => v.destVariantGid),
    ["d1", "d2"],
  );
});
test("ambiguous or incompatible variants are rejected", () => {
  assert.equal(matchVariants([variant("s1", "S")], [variant("d1", "M")]), null);
  assert.equal(
    matchVariants(
      [variant("s1", "S"), variant("s2", "S")],
      [variant("d1", "S"), variant("d2", "S")],
    ),
    null,
  );
  assert.equal(matchVariants([variant("s1", "S")], []), null);
});
