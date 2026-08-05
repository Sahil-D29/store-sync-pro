export const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        handle
        title
        variants(first: 100) {
          edges {
            node {
              id
              sku
              title
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_UPDATE_MUTATION = `#graphql
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_UPDATE_DETAILS_MUTATION = `#graphql
  mutation CollectionUpdateDetails($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection {
        id
        title
        handle
        sortOrder
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_ADD_PRODUCTS_MUTATION = `#graphql
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_REMOVE_PRODUCTS_MUTATION = `#graphql
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_REORDER_PRODUCTS_MUTATION = `#graphql
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const INVENTORY_ACTIVATE_MUTATION = `#graphql
  mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
    inventoryActivate(
      inventoryItemId: $inventoryItemId
      locationId: $locationId
      available: $available
    ) {
      inventoryLevel {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        reason
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const INVENTORY_ITEM_UPDATE_MUTATION = `#graphql
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        type {
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription {
        id
        topic
        endpoint {
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_DELETE_MUTATION = `#graphql
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_DELETE_MUTATION = `#graphql
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors {
        field
        message
      }
    }
  }
`;

export const BULK_OPERATION_RUN_QUERY = `#graphql
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        objectCount
        url
      }
      userErrors {
        field
        message
      }
    }
  }
`;
