import { createHash } from "crypto";
import type { PriceRule, ConnectedStore, DestProductStatus } from "@prisma/client";
import prisma from "../db.server";
import type { ShopifyGraphQLClient } from "./shopify-client.server";
import { GET_PRODUCT_FOR_SYNC } from "../graphql/queries";
import { PRODUCT_SET_MUTATION, PRODUCT_DELETE_MUTATION } from "../graphql/mutations";
import { transformPrice, getExchangeRate } from "./price-transformer.server";
import { checkProductLimit, incrementProductCount } from "./billing.server";
import {
  logSkippedMetafields,
  sanitizeMetafieldsForDestination,
} from "./metafield-sanitizer.server";

interface SyncProductResult {
  success: boolean;
  action: "CREATE" | "UPDATE" | "DELETE" | "SKIP";
  sourceGid: string;
  destGid?: string;
  error?: string;
  duration: number;
}

/**
 * The subset of a SyncRule's configuration actually read by the sync engine
 * (product-sync/product-extras/inventory-sync/collection-sync). Deliberately
 * not tied to the SyncRule Prisma model — a real SyncRule row (a superset,
 * with extra fields like filterType/cronExpression) is still structurally
 * assignable here, so existing callers built around a real SyncRule keep
 * working unchanged. This also lets callers with no SyncRule at all (e.g.
 * Collection Mapping's own create-settings) build one of these ad hoc.
 */
export interface SyncRuleWithRelations {
  sourceStoreId: string;
  destStoreId: string;
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
  priceRule: PriceRule | null;
  excludedFields: string | null;
  syncProducts: boolean;
  syncVariants: boolean;
  syncInventory: boolean;
  syncMetafields: boolean;
  syncImages: boolean;
  syncSeo: boolean;
  syncTags: boolean;
  destProductStatus: DestProductStatus;
}

/**
 * Sync a single product from source to destination
 */
export async function syncProduct(
  syncRule: SyncRuleWithRelations,
  sourceProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient,
  forceSync: boolean = false
): Promise<SyncProductResult> {
  const startTime = Date.now();

  try {
    // Fetch full product data from source
    console.log(`[ProductSync] Fetching product ${sourceProductGid} from source`);
    const sourceResult = await sourceClient.queryWithRetry(
      GET_PRODUCT_FOR_SYNC,
      { id: sourceProductGid }
    );

    if (sourceResult.errors?.length || !sourceResult.data?.product) {
      console.log(`[ProductSync] Failed to fetch product: ${sourceResult.errors?.[0]?.message || "Product not found"}`);
      return {
        success: false,
        action: "SKIP",
        sourceGid: sourceProductGid,
        error:
          sourceResult.errors?.[0]?.message || "Product not found on source",
        duration: Date.now() - startTime,
      };
    }

    const sourceProduct = sourceResult.data.product;

    // Check change detection via hash (includes price rule config so rule changes trigger re-sync)
    const currentHash = computeProductHash(sourceProduct, syncRule.priceRule);
    const existingMapping = await prisma.productMapping.findUnique({
      where: {
        sourceStoreId_destStoreId_sourceProductGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceProductGid,
        },
      },
    });

    if (!forceSync && existingMapping?.syncHash === currentHash && existingMapping.destProductGid) {
      return {
        success: true,
        action: "SKIP",
        sourceGid: sourceProductGid,
        destGid: existingMapping.destProductGid,
        duration: Date.now() - startTime,
      };
    }

    // Check billing limits for new products
    const isNewProduct = !existingMapping?.destProductGid;
    if (isNewProduct) {
      const limitCheck = await checkProductLimit(
        syncRule.sourceStore.shopDomain
      );
      if (!limitCheck.allowed) {
        return {
          success: false,
          action: "SKIP",
          sourceGid: sourceProductGid,
          error: `Product limit reached (${limitCheck.currentCount}/${limitCheck.limit}). Upgrade plan to sync more products.`,
          duration: Date.now() - startTime,
        };
      }
    }

    // Build ProductSetInput
    const input = await buildProductSetInput(
      sourceProduct,
      syncRule,
      existingMapping?.destProductGid || undefined,
      existingMapping?.variantMappings
        ? JSON.parse(existingMapping.variantMappings)
        : undefined
    );

    // Execute productSet on destination
    console.log(`[ProductSync] Executing productSet on destination for ${sourceProduct.handle}`);
    const destResult = await destClient.queryWithRetry(PRODUCT_SET_MUTATION, {
      input,
      synchronous: true,
    });

    if (destResult.data?.productSet?.userErrors?.length) {
      const errors = destResult.data.productSet.userErrors;
      console.log(`[ProductSync] productSet userErrors:`, JSON.stringify(errors));

      // Handle PRODUCT_DOES_NOT_EXIST: stale mapping, clear it and retry as create
      const notExistError = errors.find((e: any) => e.code === "PRODUCT_DOES_NOT_EXIST");
      if (notExistError && existingMapping?.destProductGid) {
        console.log(`[ProductSync] Dest product was deleted, clearing stale mapping and retrying as create`);
        await prisma.productMapping.delete({
          where: {
            sourceStoreId_destStoreId_sourceProductGid: {
              sourceStoreId: syncRule.sourceStoreId,
              destStoreId: syncRule.destStoreId,
              sourceProductGid,
            },
          },
        });
        // Rebuild input without destination product ID (creates new product)
        const createInput = await buildProductSetInput(
          sourceProduct,
          syncRule,
          undefined,
          undefined
        );
        const createResult = await destClient.queryWithRetry(PRODUCT_SET_MUTATION, {
          input: createInput,
          synchronous: true,
        });

        if (createResult.data?.productSet?.userErrors?.length) {
          console.log(`[ProductSync] Retry create userErrors:`, JSON.stringify(createResult.data.productSet.userErrors));
          return {
            success: false,
            action: "CREATE",
            sourceGid: sourceProductGid,
            error: createResult.data.productSet.userErrors.map((e: any) => e.message).join("; "),
            duration: Date.now() - startTime,
          };
        }

        const createdProduct = createResult.data?.productSet?.product;
        if (createdProduct) {
          const variantMappings = buildVariantMappings(
            sourceProduct.variants.edges,
            createdProduct.variants.edges
          );
          await prisma.productMapping.create({
            data: {
              sourceStoreId: syncRule.sourceStoreId,
              destStoreId: syncRule.destStoreId,
              sourceProductGid,
              destProductGid: createdProduct.id,
              sourceHandle: sourceProduct.handle,
              variantMappings: JSON.stringify(variantMappings),
              syncHash: currentHash,
              status: "SYNCED",
              lastSyncedAt: new Date(),
            },
          });
          if (isNewProduct) await incrementProductCount(syncRule.sourceStore.shopDomain);
          return {
            success: true,
            action: "CREATE",
            sourceGid: sourceProductGid,
            destGid: createdProduct.id,
            duration: Date.now() - startTime,
          };
        }
      }

      // Handle HANDLE_NOT_UNIQUE: look up existing product on destination and retry as update
      const handleError = errors.find((e: any) => e.code === "HANDLE_NOT_UNIQUE");
      if (handleError && isNewProduct) {
        console.log(`[ProductSync] Handle '${sourceProduct.handle}' exists on destination, looking up existing product`);
        const lookupResult = await destClient.queryWithRetry(
          `#graphql
          query GetProductByHandle($handle: String!) {
            productByHandle(handle: $handle) {
              id
              variants(first: 100) {
                edges { node { id sku title } }
              }
            }
          }`,
          { handle: sourceProduct.handle }
        );

        const existingDest = lookupResult.data?.productByHandle;
        if (existingDest) {
          console.log(`[ProductSync] Found existing dest product ${existingDest.id}, retrying as update`);
          // Rebuild input with the existing destination product ID
          const retryInput = await buildProductSetInput(
            sourceProduct,
            syncRule,
            existingDest.id,
            undefined
          );
          const retryResult = await destClient.queryWithRetry(PRODUCT_SET_MUTATION, {
            input: retryInput,
            synchronous: true,
          });

          if (retryResult.data?.productSet?.userErrors?.length) {
            console.log(`[ProductSync] Retry productSet userErrors:`, JSON.stringify(retryResult.data.productSet.userErrors));
            return {
              success: false,
              action: "UPDATE",
              sourceGid: sourceProductGid,
              error: retryResult.data.productSet.userErrors.map((e: any) => e.message).join("; "),
              duration: Date.now() - startTime,
            };
          }

          const retryProduct = retryResult.data?.productSet?.product;
          if (retryProduct) {
            const variantMappings = buildVariantMappings(
              sourceProduct.variants.edges,
              retryProduct.variants.edges
            );
            await prisma.productMapping.upsert({
              where: {
                sourceStoreId_destStoreId_sourceProductGid: {
                  sourceStoreId: syncRule.sourceStoreId,
                  destStoreId: syncRule.destStoreId,
                  sourceProductGid,
                },
              },
              update: {
                destProductGid: retryProduct.id,
                variantMappings: JSON.stringify(variantMappings),
                syncHash: currentHash,
                status: "SYNCED",
                lastSyncedAt: new Date(),
              },
              create: {
                sourceStoreId: syncRule.sourceStoreId,
                destStoreId: syncRule.destStoreId,
                sourceProductGid,
                destProductGid: retryProduct.id,
                sourceHandle: sourceProduct.handle,
                variantMappings: JSON.stringify(variantMappings),
                syncHash: currentHash,
                status: "SYNCED",
                lastSyncedAt: new Date(),
              },
            });
            return {
              success: true,
              action: "UPDATE",
              sourceGid: sourceProductGid,
              destGid: retryProduct.id,
              duration: Date.now() - startTime,
            };
          }
        }
      }

      return {
        success: false,
        action: isNewProduct ? "CREATE" : "UPDATE",
        sourceGid: sourceProductGid,
        error: errors.map((e: any) => e.message).join("; "),
        duration: Date.now() - startTime,
      };
    }

    const destProduct = destResult.data?.productSet?.product;
    if (!destProduct) {
      return {
        success: false,
        action: isNewProduct ? "CREATE" : "UPDATE",
        sourceGid: sourceProductGid,
        error: "No product returned from productSet",
        duration: Date.now() - startTime,
      };
    }

    // Build variant mappings
    const variantMappings = buildVariantMappings(
      sourceProduct.variants.edges,
      destProduct.variants.edges
    );

    // Update product mapping
    await prisma.productMapping.upsert({
      where: {
        sourceStoreId_destStoreId_sourceProductGid: {
          sourceStoreId: syncRule.sourceStoreId,
          destStoreId: syncRule.destStoreId,
          sourceProductGid,
        },
      },
      update: {
        destProductGid: destProduct.id,
        variantMappings: JSON.stringify(variantMappings),
        syncHash: currentHash,
        status: "SYNCED",
        lastSyncedAt: new Date(),
      },
      create: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceProductGid,
        destProductGid: destProduct.id,
        sourceHandle: sourceProduct.handle,
        variantMappings: JSON.stringify(variantMappings),
        syncHash: currentHash,
        status: "SYNCED",
        lastSyncedAt: new Date(),
      },
    });

    // Increment product count for new products
    if (isNewProduct) {
      await incrementProductCount(syncRule.sourceStore.shopDomain);
    }

    return {
      success: true,
      action: isNewProduct ? "CREATE" : "UPDATE",
      sourceGid: sourceProductGid,
      destGid: destProduct.id,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "SKIP",
      sourceGid: sourceProductGid,
      error: (error as Error).message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Delete a product from destination store
 */
export async function deleteProductOnDestination(
  syncRule: SyncRuleWithRelations,
  sourceProductGid: string,
  destClient: ShopifyGraphQLClient
): Promise<SyncProductResult> {
  const startTime = Date.now();

  const mapping = await prisma.productMapping.findUnique({
    where: {
      sourceStoreId_destStoreId_sourceProductGid: {
        sourceStoreId: syncRule.sourceStoreId,
        destStoreId: syncRule.destStoreId,
        sourceProductGid,
      },
    },
  });

  if (!mapping?.destProductGid) {
    return {
      success: true,
      action: "SKIP",
      sourceGid: sourceProductGid,
      duration: Date.now() - startTime,
    };
  }

  try {
    await destClient.queryWithRetry(PRODUCT_DELETE_MUTATION, {
      input: { id: mapping.destProductGid },
    });

    await prisma.productMapping.delete({ where: { id: mapping.id } });

    return {
      success: true,
      action: "DELETE",
      sourceGid: sourceProductGid,
      destGid: mapping.destProductGid,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "DELETE",
      sourceGid: sourceProductGid,
      error: (error as Error).message,
      duration: Date.now() - startTime,
    };
  }
}

async function buildProductSetInput(
  sourceProduct: any,
  syncRule: SyncRuleWithRelations,
  existingDestProductId?: string,
  existingVariantMappings?: Array<{
    sourceVariantGid: string;
    destVariantGid: string;
    sourceSku: string;
  }>
): Promise<any> {
  const excludedFields: string[] = syncRule.excludedFields
    ? JSON.parse(syncRule.excludedFields)
    : [];

  const input: any = {
    title: sourceProduct.title,
    handle: sourceProduct.handle,
  };

  // Set destination product ID if updating existing
  if (existingDestProductId) {
    input.id = existingDestProductId;
  }

  // Product fields (respecting toggle + exclusions)
  if (syncRule.syncProducts) {
    if (!excludedFields.includes("description")) {
      input.descriptionHtml = sourceProduct.descriptionHtml;
    }
    if (!excludedFields.includes("vendor")) {
      input.vendor = sourceProduct.vendor;
    }
    if (!excludedFields.includes("productType")) {
      input.productType = sourceProduct.productType;
    }

    // Product status
    switch (syncRule.destProductStatus) {
      case "ALWAYS_ACTIVE":
        input.status = "ACTIVE";
        break;
      case "ALWAYS_DRAFT":
        input.status = "DRAFT";
        break;
      default:
        input.status = sourceProduct.status;
    }
  }

  // Tags
  if (syncRule.syncTags && !excludedFields.includes("tags")) {
    input.tags = sourceProduct.tags;
  }

  // SEO
  if (syncRule.syncSeo && !excludedFields.includes("seo")) {
    input.seo = sourceProduct.seo;
  }

  // Product options
  if (sourceProduct.options?.length) {
    input.productOptions = sourceProduct.options.map((opt: any) => ({
      name: opt.name,
      position: opt.position,
      values: opt.values.map((v: any) => ({ name: v })),
    }));
  }

  // Variants with price transformation
  if (syncRule.syncVariants) {
    let exchangeRate: number | undefined;
    if (
      syncRule.priceRule?.type === "CURRENCY_CONVERSION" &&
      syncRule.sourceStore.currencyCode !== syncRule.priceRule.targetCurrency
    ) {
      // Use manual rate if set, otherwise fetch from API
      const manualRate = (syncRule.priceRule as any).manualExchangeRate;
      if (manualRate) {
        exchangeRate = manualRate;
        console.log(`[ProductSync] Using manual exchange rate: ${manualRate}`);
      } else {
        exchangeRate = await getExchangeRate(
          syncRule.sourceStore.currencyCode,
          syncRule.priceRule.targetCurrency
        );
        console.log(`[ProductSync] Using API exchange rate: ${exchangeRate}`);
      }
    }

    input.variants = sourceProduct.variants.edges.map(
      (edge: any, index: number) => {
        const variant = edge.node;
        const variantInput: any = {
          position: index + 1,
          sku: variant.sku,
          barcode: variant.barcode,
          optionValues: variant.selectedOptions?.map((opt: any) => ({
            optionName: opt.name,
            name: opt.value,
          })),
        };

        // Map existing destination variant ID
        if (existingVariantMappings) {
          const mapping = existingVariantMappings.find(
            (m) => m.sourceVariantGid === variant.id
          );
          if (mapping?.destVariantGid) {
            variantInput.id = mapping.destVariantGid;
          }
        }

        // Inventory sync is explicit opt-in. Enable tracking on destination so
        // the later inventory quantity write is visible even if source tracking
        // is disabled but Shopify still exposes an available quantity.
        if (syncRule.syncInventory) {
          variantInput.inventoryItem = { tracked: true };
          variantInput.inventoryPolicy = variant.inventoryPolicy || "DENY";
        }

        // Price transformation
        if (syncRule.priceRule) {
          const transformed = transformPrice(
            variant.price,
            variant.compareAtPrice,
            syncRule.priceRule,
            syncRule.sourceStore.currencyCode,
            exchangeRate
          );
          console.log(`[ProductSync] Price transform: ${variant.price} -> ${transformed.price} (rule: ${syncRule.priceRule.type}, value: ${syncRule.priceRule.value}, rate: ${exchangeRate || 'N/A'})`);
          variantInput.price = parseFloat(transformed.price);
          if (transformed.compareAtPrice) {
            variantInput.compareAtPrice = parseFloat(
              transformed.compareAtPrice
            );
          }
        } else {
          variantInput.price = parseFloat(variant.price);
          if (variant.compareAtPrice) {
            variantInput.compareAtPrice = parseFloat(variant.compareAtPrice);
          }
        }

        return variantInput;
      }
    );
  }

  // Metafields
  if (
    syncRule.syncMetafields &&
    sourceProduct.metafields?.edges?.length
  ) {
    const { metafields, skipped } = sanitizeMetafieldsForDestination(
      sourceProduct.metafields.edges
      .map((edge: any) => edge.node)
      .map((metafield: any) => ({
        namespace: metafield.namespace,
        key: metafield.key,
        value: metafield.value,
        type: metafield.type,
      }))
    );

    logSkippedMetafields(
      skipped,
      `productSet for ${sourceProduct.handle || sourceProduct.id}`
    );

    if (metafields.length) {
      input.metafields = metafields;
    }
  }

  return input;
}

/**
 * Build variant mappings between source and destination
 */
function buildVariantMappings(
  sourceVariantEdges: any[],
  destVariantEdges: any[]
): Array<{
  sourceVariantGid: string;
  destVariantGid: string;
  sourceSku: string;
}> {
  return sourceVariantEdges.map((sourceEdge: any, index: number) => {
    const destEdge = destVariantEdges[index];
    return {
      sourceVariantGid: sourceEdge.node.id,
      destVariantGid: destEdge?.node?.id || "",
      sourceSku: sourceEdge.node.sku || "",
    };
  });
}

/**
 * Compute a hash of product data for change detection.
 * Includes price rule config so that adding/changing a price rule triggers re-sync.
 */
function computeProductHash(product: any, priceRule?: PriceRule | null): string {
  const relevantData = {
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: product.status,
    seo: product.seo,
    variants: product.variants?.edges?.map((e: any) => ({
      sku: e.node.sku,
      price: e.node.price,
      compareAtPrice: e.node.compareAtPrice,
      barcode: e.node.barcode,
      inventoryQuantity: e.node.inventoryQuantity,
      inventoryPolicy: e.node.inventoryPolicy,
      tracked: e.node.inventoryItem?.tracked,
    })),
    metafields: product.metafields?.edges?.map((e: any) => ({
      namespace: e.node.namespace,
      key: e.node.key,
      value: e.node.value,
    })),
    // Include price rule config so rule changes invalidate the hash
    priceRule: priceRule
      ? {
          id: priceRule.id,
          type: priceRule.type,
          value: priceRule.value,
          targetCurrency: priceRule.targetCurrency,
          manualExchangeRate: (priceRule as any).manualExchangeRate ?? null,
          roundTo: priceRule.roundTo,
          applyToCompareAt: priceRule.applyToCompareAt,
        }
      : null,
  };

  return createHash("md5")
    .update(JSON.stringify(relevantData))
    .digest("hex");
}
