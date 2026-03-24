import type { SyncRule, ConnectedStore, PriceRule } from "@prisma/client";
import { ShopifyGraphQLClient } from "./shopify-client.server";
import {
  METAFIELDS_SET_MUTATION,
  METAFIELD_DEFINITION_CREATE_MUTATION,
} from "../graphql/mutations";

type SyncRuleWithRelations = SyncRule & {
  sourceStore: ConnectedStore;
  destStore: ConnectedStore;
  priceRule: PriceRule | null;
};

interface MetafieldData {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

interface SyncMetafieldResult {
  success: boolean;
  synced: number;
  created: number;
  errors: string[];
}

// Cache of definitions we've already ensured exist on destination stores
const definitionCache = new Set<string>();

/**
 * Sync metafields from source to destination for a given resource
 */
export async function syncMetafields(
  ownerGid: string,
  metafields: MetafieldData[],
  destClient: ShopifyGraphQLClient,
  ownerType: string = "PRODUCT"
): Promise<SyncMetafieldResult> {
  const result: SyncMetafieldResult = {
    success: true,
    synced: 0,
    created: 0,
    errors: [],
  };

  if (!metafields.length) return result;

  // Ensure metafield definitions exist on destination
  for (const mf of metafields) {
    await ensureMetafieldDefinition(mf, destClient, ownerType);
  }

  // Set metafields on the destination resource
  const metafieldsInput = metafields.map((mf) => ({
    ownerId: ownerGid,
    namespace: mf.namespace,
    key: mf.key,
    value: mf.value,
    type: mf.type,
  }));

  // Batch in groups of 25 (Shopify limit)
  for (let i = 0; i < metafieldsInput.length; i += 25) {
    const batch = metafieldsInput.slice(i, i + 25);

    try {
      const setResult = await destClient.queryWithRetry(
        METAFIELDS_SET_MUTATION,
        { metafields: batch }
      );

      if (setResult.data?.metafieldsSet?.userErrors?.length) {
        for (const err of setResult.data.metafieldsSet.userErrors) {
          result.errors.push(err.message);
        }
      } else {
        result.synced += batch.length;
      }
    } catch (error) {
      result.errors.push((error as Error).message);
      result.success = false;
    }
  }

  if (result.errors.length > 0) {
    result.success = false;
  }

  return result;
}

/**
 * Ensure a metafield definition exists on the destination store.
 * Auto-creates it if missing using metafieldDefinitionCreate.
 */
async function ensureMetafieldDefinition(
  metafield: MetafieldData,
  destClient: ShopifyGraphQLClient,
  ownerType: string
): Promise<void> {
  const cacheKey = `${destClient.getShopDomain()}:${ownerType}:${metafield.namespace}:${metafield.key}`;

  if (definitionCache.has(cacheKey)) return;

  // Check if definition already exists
  const checkResult = await destClient.queryWithRetry(
    `#graphql
    query CheckMetafieldDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
      metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, key: $key, first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }`,
    {
      ownerType,
      namespace: metafield.namespace,
      key: metafield.key,
    }
  );

  const exists = checkResult.data?.metafieldDefinitions?.edges?.length > 0;

  if (!exists) {
    // Create the definition
    const createResult = await destClient.queryWithRetry(
      METAFIELD_DEFINITION_CREATE_MUTATION,
      {
        definition: {
          name: formatDefinitionName(metafield.namespace, metafield.key),
          namespace: metafield.namespace,
          key: metafield.key,
          type: metafield.type,
          ownerType,
        },
      }
    );

    if (createResult.data?.metafieldDefinitionCreate?.userErrors?.length) {
      const errors = createResult.data.metafieldDefinitionCreate.userErrors;
      // If it's a "already exists" error, that's fine
      const isAlreadyExists = errors.some(
        (e: any) =>
          e.message?.includes("already exists") ||
          e.message?.includes("taken")
      );
      if (!isAlreadyExists) {
        console.error(
          `[MetafieldSync] Failed to create definition ${metafield.namespace}.${metafield.key}:`,
          errors[0].message
        );
      }
    }
  }

  definitionCache.add(cacheKey);
}

/**
 * Format a readable name from namespace and key
 */
function formatDefinitionName(namespace: string, key: string): string {
  // Convert "custom.my_field" to "Custom - My Field"
  const formattedKey = key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const formattedNamespace = namespace
    .split(".")
    .pop()!
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return `${formattedNamespace} - ${formattedKey}`;
}

/**
 * Fetch all metafields for a resource from source store
 */
export async function fetchResourceMetafields(
  resourceGid: string,
  sourceClient: ShopifyGraphQLClient
): Promise<MetafieldData[]> {
  const metafields: MetafieldData[] = [];
  let hasNext = true;
  let cursor: string | null = null;

  // Determine resource type from GID
  const resourceType = resourceGid.includes("Product")
    ? "product"
    : resourceGid.includes("Collection")
    ? "collection"
    : null;

  if (!resourceType) return metafields;

  while (hasNext) {
    const query =
      resourceType === "product"
        ? `#graphql
      query GetProductMetafields($id: ID!, $first: Int!, $after: String) {
        product(id: $id) {
          metafields(first: $first, after: $after) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`
        : `#graphql
      query GetCollectionMetafields($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          metafields(first: $first, after: $after) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`;

    const result: any = await sourceClient.queryWithRetry(query, {
      id: resourceGid,
      first: 50,
      after: cursor,
    });

    const resource =
      result.data?.product || result.data?.collection;
    if (!resource?.metafields) break;

    for (const edge of resource.metafields.edges) {
      metafields.push({
        namespace: edge.node.namespace,
        key: edge.node.key,
        value: edge.node.value,
        type: edge.node.type,
      });
    }

    hasNext = resource.metafields.pageInfo.hasNextPage;
    cursor = resource.metafields.pageInfo.endCursor;
  }

  return metafields;
}
