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

const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
        code
      }
    }
  }
`;

const PRODUCT_DELETE_MEDIA_MUTATION = `#graphql
  mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Sync product images from source to destination using productCreateMedia.
 * Deletes existing dest images first, then re-creates from source URLs.
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
          media(first: 20) {
            edges {
              node {
                alt
                mediaContentType
                ... on MediaImage {
                  id
                  image {
                    url
                    altText
                    width
                    height
                  }
                }
              }
            }
          }
        }
      }`,
      { id: sourceProductGid }
    );

    const sourceMedia =
      sourceResult.data?.product?.media?.edges?.map((e: any) => e.node) || [];
    const sourceImages: ImageData[] = sourceMedia
      .filter((m: any) => m.mediaContentType === "IMAGE" && m.image?.url)
      .map((m: any) => ({
        url: m.image.url,
        altText: m.image.altText || m.alt || null,
      }));

    console.log(`[MediaSync] Source product ${sourceProductGid} has ${sourceImages.length} images`);

    if (!sourceImages.length) return result;

    // Get current destination media to check what exists
    const destResult = await destClient.queryWithRetry(
      `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          media(first: 20) {
            edges {
              node {
                alt
                mediaContentType
                ... on MediaImage {
                  id
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }`,
      { id: destProductGid }
    );

    const destMedia =
      destResult.data?.product?.media?.edges?.map((e: any) => e.node) || [];
    const destImageIds = destMedia
      .filter((m: any) => m.mediaContentType === "IMAGE" && m.id)
      .map((m: any) => m.id);

    console.log(`[MediaSync] Dest product ${destProductGid} has ${destImageIds.length} existing images`);

    // Delete existing dest images so we can replace with source images
    if (destImageIds.length > 0) {
      const deleteResult = await destClient.queryWithRetry(
        PRODUCT_DELETE_MEDIA_MUTATION,
        { productId: destProductGid, mediaIds: destImageIds }
      );
      if (deleteResult.data?.productDeleteMedia?.mediaUserErrors?.length) {
        for (const err of deleteResult.data.productDeleteMedia.mediaUserErrors) {
          console.warn(`[MediaSync] Delete media warning: ${err.message}`);
        }
      }
    }

    // Create source images on destination using productCreateMedia
    const mediaInputs = sourceImages.map((img) => ({
      originalSource: img.url,
      alt: img.altText || "",
      mediaContentType: "IMAGE" as const,
    }));

    const createResult = await destClient.queryWithRetry(
      PRODUCT_CREATE_MEDIA_MUTATION,
      { productId: destProductGid, media: mediaInputs }
    );

    if (createResult.data?.productCreateMedia?.mediaUserErrors?.length) {
      for (const err of createResult.data.productCreateMedia.mediaUserErrors) {
        result.errors.push(err.message);
        console.error(`[MediaSync] Create media error: ${err.message} (code: ${err.code})`);
      }
      result.success = result.errors.length === 0;
    }

    result.synced = sourceImages.length - result.errors.length;
    console.log(`[MediaSync] Synced ${result.synced} images to dest product ${destProductGid}`);
  } catch (error) {
    result.errors.push((error as Error).message);
    result.success = false;
    console.error(`[MediaSync] Error syncing images:`, error);
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
