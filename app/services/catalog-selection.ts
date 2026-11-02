export const PRODUCT_STATUSES = [
  "ACTIVE",
  "DRAFT",
  "UNLISTED",
  "ARCHIVED",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export type CatalogProduct = {
  id: string;
  title: string;
  handle: string;
  status: ProductStatus;
  tags: string[];
  collections: Array<{ id: string; title: string }>;
};
export type RemainingProduct = CatalogProduct & {
  state: "SYNCED" | "MATCHED" | "UNMATCHED" | "FAILED";
  destId: string | null;
  existsInDestination?: boolean;
};
export type CatalogSelection = {
  statuses: ProductStatus[];
  method: "ALL" | "COLLECTIONS" | "TAGS" | "MANUAL";
  collectionIds: string[];
  tags: string[];
  productIds: string[];
  tagMode: "ANY" | "ALL";
  missingOnly?: boolean;
  existingOnly?: boolean;
  priceRuleId?: string | null;
};
export const DEFAULT_SELECTION: CatalogSelection = {
  statuses: [...PRODUCT_STATUSES],
  method: "ALL",
  collectionIds: [],
  tags: [],
  productIds: [],
  tagMode: "ANY",
};
export function parseSelection(value: unknown): CatalogSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid product selection");
  const input = value as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const items = input[key];
    if (
      !Array.isArray(items) ||
      items.some((v) => typeof v !== "string" || v.length > 500)
    )
      throw new Error(`Invalid ${key}`);
    return [...new Set(items as string[])];
  };
  const statuses = strings("statuses");
  if (
    statuses.some((s) => !(PRODUCT_STATUSES as readonly string[]).includes(s))
  )
    throw new Error("Invalid product status");
  if (!["ALL", "COLLECTIONS", "TAGS", "MANUAL"].includes(String(input.method)))
    throw new Error("Invalid selection method");
  if (!["ANY", "ALL"].includes(String(input.tagMode)))
    throw new Error("Invalid tag matching mode");
  const selection = {
    statuses,
    method: input.method,
    collectionIds: strings("collectionIds"),
    tags: strings("tags"),
    productIds: strings("productIds"),
    tagMode: input.tagMode,
    missingOnly: input.missingOnly === true,
    existingOnly: input.existingOnly === true,
    priceRuleId: input.priceRuleId || null,
  } as CatalogSelection;
  if (
    input.existingOnly !== undefined &&
    typeof input.existingOnly !== "boolean"
  )
    throw new Error("Invalid existing-product selection");
  if (selection.missingOnly && selection.existingOnly)
    throw new Error(
      "Choose either adding missing products or updating existing products",
    );
  if (
    input.priceRuleId !== undefined &&
    input.priceRuleId !== null &&
    (typeof input.priceRuleId !== "string" || input.priceRuleId.length > 200)
  )
    throw new Error("Invalid price rule");
  if (input.missingOnly !== undefined && typeof input.missingOnly !== "boolean")
    throw new Error("Invalid missing-product selection");
  if (
    selection.collectionIds.some(
      (id) => !/^gid:\/\/shopify\/Collection\/\d+$/.test(id),
    ) ||
    selection.productIds.some(
      (id) => !/^gid:\/\/shopify\/Product\/\d+$/.test(id),
    )
  )
    throw new Error("Invalid Shopify product or collection ID");
  return selection;
}
export function selectRemaining(
  products: RemainingProduct[],
  selection: CatalogSelection,
): RemainingProduct[] {
  const statuses = new Set(selection.statuses);
  const ids = new Set(selection.productIds);
  const collections = new Set(selection.collectionIds);
  const tags = selection.tags.map((tag) => tag.toLowerCase());
  return products.filter((p) => {
    if (!statuses.has(p.status)) return false;
    if (selection.existingOnly) {
      if (p.existsInDestination !== true) return false;
    } else if (p.state === "SYNCED") return false;
    if (selection.missingOnly && p.existsInDestination !== false) return false;
    switch (selection.method) {
      case "ALL":
        return true;
      case "MANUAL":
        return ids.has(p.id);
      case "COLLECTIONS":
        return p.collections.some((c) => collections.has(c.id));
      case "TAGS": {
        const productTags = new Set(p.tags.map((tag) => tag.toLowerCase()));
        return (
          tags.length > 0 &&
          (selection.tagMode === "ALL"
            ? tags.every((t) => productTags.has(t))
            : tags.some((t) => productTags.has(t)))
        );
      }
      default:
        return false;
    }
  });
}
export function matchesCatalogRule(
  product: CatalogProduct,
  rule: {
    filterType: string;
    filterProductIds: string | null;
    filterCollectionIds: string | null;
    filterTags: string | null;
  },
) {
  const list = (value: string | null): string[] =>
    value ? JSON.parse(value) : [];
  switch (rule.filterType) {
    case "ALL":
      return true;
    case "SELECTED_PRODUCTS":
      return list(rule.filterProductIds).includes(product.id);
    case "SELECTED_COLLECTIONS":
      return product.collections.some((c) =>
        list(rule.filterCollectionIds).includes(c.id),
      );
    case "BY_TAGS":
      return (rule.filterTags || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .some((t) => product.tags.some((pt) => pt.toLowerCase() === t));
    default:
      throw new Error("Unsupported sync rule filter");
  }
}
export type CatalogVariant = {
  id: string;
  sku: string;
  selectedOptions: Array<{ name: string; value: string }>;
};
export function matchVariants(
  source: CatalogVariant[],
  destination: CatalogVariant[],
) {
  const key = (variant: CatalogVariant) =>
    JSON.stringify(
      [...variant.selectedOptions].sort((a, b) => a.name.localeCompare(b.name)),
    );
  const sourceKeys = source.map(key);
  const destKeys = destination.map(key);
  if (
    source.length !== destination.length ||
    new Set(sourceKeys).size !== source.length ||
    new Set(destKeys).size !== destination.length ||
    sourceKeys.some((k) => !destKeys.includes(k))
  )
    return null;
  return source.map((variant, index) => ({
    sourceVariantGid: variant.id,
    destVariantGid: destination[destKeys.indexOf(sourceKeys[index])].id,
    sourceSku: variant.sku || "",
  }));
}
