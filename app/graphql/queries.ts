export const GET_PRODUCT_FOR_SYNC = `#graphql
  query GetProductForSync($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      tags
      status
      seo {
        title
        description
      }
      options {
        name
        position
        values
      }
      variants(first: 100) {
        edges {
          node {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            inventoryPolicy
            inventoryItem {
              id
              tracked
            }
            selectedOptions {
              name
              value
            }
          }
        }
      }
      metafields(first: 50) {
        edges {
          node {
            id
            namespace
            key
            value
            type
          }
        }
      }
      images(first: 20) {
        edges {
          node {
            id
            url
            altText
            width
            height
          }
        }
      }
    }
  }
`;

export const GET_PRODUCTS_PAGINATED = `#graphql
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          status
          updatedAt
          variants(first: 3) {
            edges {
              node {
                id
                price
              }
            }
          }
          images(first: 1) {
            edges {
              node {
                url
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_COLLECTIONS = `#graphql
  query GetCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          sortOrder
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
          image {
            url
            altText
          }
          seo {
            title
            description
          }
          productsCount {
            count
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_COLLECTION_PRODUCTS = `#graphql
  query GetCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            handle
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const GET_JOB_STATUS = `#graphql
  query GetJobStatus($id: ID!) {
    job(id: $id) {
      id
      done
    }
  }
`;

export const GET_PRODUCT_METAFIELDS = `#graphql
  query GetProductMetafields($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      metafields(first: $first, after: $after) {
        edges {
          node {
            id
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
  }
`;

export const GET_INVENTORY_LEVELS = `#graphql
  query GetInventoryLevels($inventoryItemId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      id
      inventoryLevels(first: 10) {
        edges {
          node {
            id
            location {
              id
              name
            }
            quantities(names: ["available", "on_hand"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

export const GET_SHOP_INFO = `#graphql
  query {
    shop {
      name
      currencyCode
      primaryDomain {
        url
      }
      plan {
        displayName
      }
    }
  }
`;
