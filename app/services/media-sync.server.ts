import { ShopifyGraphQLClient } from "./shopify-client.server";

interface ImageData {
  url: string;
  altText: string | null;
  width?: number;
  height?: number;
}

interface SyncMediaResult {
  success: boolean;
  synced: number;
  errors: string[];
}

/**
 * Sync product images from source to destination.
 * Images are referenced by URL - Shopify will download and host them.
 * This is handled within productSet by including media/images in the input.
 */
export async function syncProductImages(
  sourceProductGid: string,
  destProductGid: string,
  sourceClient: ShopifyGraphQLClient,
  destClient: ShopifyGraphQLClient
): Promise<SyncMediaResult> {
  const result: SyncMediaResult = {
    success: true,
    synced: 0,
    errors: [],
  };

  try {
    // Fetch source product images
    const sourceResult = await sourceClient.queryWithRetry(
      `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          images(first: 20) {
            edges {
              node {
                url
                altText
                width
                height
              }
            }
          }
        }
      }`,
      { id: sourceProductGid }
    );

    const sourceImages: ImageData[] =
      sourceResult.data?.product?.images?.edges?.map(
        (e: any) => e.node
      ) || [];

    if (!sourceImages.length) return result;

    // Get current destination images to avoid duplicates
    const destResult = await destClient.queryWithRetry(
      `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          images(first: 20) {
            edges {
              node {
                id
                url
              }
            }
          }
        }
      }`,
      { id: destProductGid }
    );

    const destImages =
      destResult.data?.product?.images?.edges?.map((e: any) => e.node) || [];

    // If destination already has images, skip (images are synced via productSet)
    // This service handles additional media sync scenarios
    if (destImages.length > 0) {
      result.synced = destImages.length;
      return result;
    }

    // Use productUpdate to add images by URL
    const imageInputs = sourceImages.map((img) => ({
      src: img.url,
      altText: img.altText || "",
    }));

    const updateResult = await destClient.queryWithRetry(
      `#graphql
      mutation ProductUpdateImages($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            images(first: 20) {
              edges {
                node {
                  id
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        input: {
          id: destProductGid,
          images: imageInputs,
        },
      }
    );

    if (updateResult.data?.productUpdate?.userErrors?.length) {
      for (const err of updateResult.data.productUpdate.userErrors) {
        result.errors.push(err.message);
      }
      result.success = false;
    } else {
      result.synced = sourceImages.length;
    }
  } catch (error) {
    result.errors.push((error as Error).message);
    result.success = false;
  }

  return result;
}

/**
 * Build image inputs for productSet mutation
 * Returns array of image objects that can be included in ProductSetInput
 */
export function buildImageInputsForProductSet(
  sourceImages: Array<{ url: string; altText: string | null }>
): Array<{ src: string; altText: string }> {
  return sourceImages.map((img) => ({
    src: img.url,
    altText: img.altText || "",
  }));
}
