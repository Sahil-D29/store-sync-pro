import prisma from "../db.server";
import { decrypt } from "../utils/encryption.server";

const API_VERSION = "2025-01";

interface GraphQLResponse<T = any> {
  data?: T;
  errors?: Array<{ message: string; locations?: any[]; path?: any[] }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

interface RateLimitState {
  availablePoints: number;
  maxPoints: number;
  restoreRate: number;
  lastUpdated: number;
}

// Per-store rate limiter instances
const rateLimiters = new Map<string, RateLimitState>();

function getRateLimiter(shopDomain: string): RateLimitState {
  if (!rateLimiters.has(shopDomain)) {
    rateLimiters.set(shopDomain, {
      availablePoints: 1000,
      maxPoints: 1000,
      restoreRate: 50,
      lastUpdated: Date.now(),
    });
  }
  return rateLimiters.get(shopDomain)!;
}

function restorePoints(state: RateLimitState): void {
  const now = Date.now();
  const elapsed = (now - state.lastUpdated) / 1000;
  state.availablePoints = Math.min(
    state.maxPoints,
    state.availablePoints + elapsed * state.restoreRate
  );
  state.lastUpdated = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ShopifyGraphQLClient {
  private shopDomain: string;
  private accessToken: string;
  private apiVersion: string;

  constructor(shopDomain: string, accessToken: string, apiVersion?: string) {
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion || API_VERSION;
  }

  async query<T = any>(
    query: string,
    variables?: Record<string, any>
  ): Promise<GraphQLResponse<T>> {
    const limiter = getRateLimiter(this.shopDomain);
    restorePoints(limiter);

    // Wait if points are low
    if (limiter.availablePoints < 200) {
      const waitMs =
        ((200 - limiter.availablePoints) / limiter.restoreRate) * 1000;
      await sleep(Math.min(waitMs, 10000));
      restorePoints(limiter);
    }

    const url = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
      await sleep(waitTime);
      return this.query(query, variables);
    }

    if (!response.ok) {
      throw new Error(
        `Shopify API error: ${response.status} ${response.statusText}`
      );
    }

    const result: GraphQLResponse<T> = await response.json();

    // Update rate limit state from response
    if (result.extensions?.cost?.throttleStatus) {
      const throttle = result.extensions.cost.throttleStatus;
      limiter.availablePoints = throttle.currentlyAvailable;
      limiter.maxPoints = throttle.maximumAvailable;
      limiter.restoreRate = throttle.restoreRate;
      limiter.lastUpdated = Date.now();
    }

    return result;
  }

  async queryWithRetry<T = any>(
    query: string,
    variables?: Record<string, any>,
    maxRetries = 3
  ): Promise<GraphQLResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.query<T>(query, variables);

        if (result.errors?.length) {
          const isThrottled = result.errors.some(
            (e) =>
              e.message.includes("Throttled") || e.message.includes("throttle")
          );
          if (isThrottled && attempt < maxRetries - 1) {
            await sleep(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
            continue;
          }
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries - 1) {
          await sleep(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
        }
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }

  getShopDomain(): string {
    return this.shopDomain;
  }
}

/**
 * Validate a store's access token by making a test query
 */
export async function validateStoreToken(
  shopDomain: string,
  accessToken: string
): Promise<{ valid: boolean; shopName?: string; currencyCode?: string; error?: string }> {
  const client = new ShopifyGraphQLClient(shopDomain, accessToken);

  try {
    const result = await client.query<{
      shop: { name: string; currencyCode: string };
    }>(
      `#graphql
      query {
        shop {
          name
          currencyCode
        }
      }`
    );

    if (result.errors?.length) {
      return { valid: false, error: result.errors[0].message };
    }

    return {
      valid: true,
      shopName: result.data?.shop.name,
      currencyCode: result.data?.shop.currencyCode,
    };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}

/**
 * Create a GraphQL client for a ConnectedStore by ID.
 * Tries the freshest offline session token first (from Shopify's PrismaSessionStorage),
 * falling back to the ConnectedStore's stored encrypted token.
 */
export async function createClientForStore(
  storeId: string
): Promise<ShopifyGraphQLClient> {
  const store = await prisma.connectedStore.findUnique({
    where: { id: storeId },
  });

  if (!store) {
    throw new Error(`Store not found: ${storeId}`);
  }

  if (store.status === "DISCONNECTED") {
    throw new Error(`Store is disconnected: ${store.shopDomain}`);
  }

  // Try to get the freshest token from the Session table
  // (PrismaSessionStorage keeps this updated on each auth)
  // Strategy: try offline session first (id = "offline_<shop>"), then any session for this shop
  const offlineSession = await prisma.session.findUnique({
    where: { id: `offline_${store.shopDomain}` },
  });

  if (offlineSession?.accessToken) {
    // Shopify offline access tokens do NOT expire (valid until app is uninstalled).
    // The `expires` field may be set incorrectly — ignore it for offline sessions.
    console.log(`[ClientFactory] Using offline session token for ${store.shopDomain} (id=${offlineSession.id})`);
    return new ShopifyGraphQLClient(store.shopDomain, offlineSession.accessToken);
  }

  // Fallback: find ANY session for this shop (online sessions from token exchange)
  const anySession = await prisma.session.findFirst({
    where: { shop: store.shopDomain },
    orderBy: { id: "desc" },
  });

  if (anySession?.accessToken) {
    const isExpired = anySession.expires && new Date(anySession.expires) < new Date();
    console.log(`[ClientFactory] Using session token for ${store.shopDomain} (id=${anySession.id}, isOnline=${anySession.isOnline}, expires=${anySession.expires}, expired=${isExpired})`);
    if (!isExpired) {
      return new ShopifyGraphQLClient(store.shopDomain, anySession.accessToken);
    }
    console.log(`[ClientFactory] Session token expired for ${store.shopDomain}, falling back to ConnectedStore token`);
  }

  // Fallback to the ConnectedStore's encrypted token
  console.log(`[ClientFactory] Using ConnectedStore token for ${store.shopDomain} (no offline session found)`);
  const token = decrypt(store.accessToken);
  return new ShopifyGraphQLClient(store.shopDomain, token);
}

/**
 * Create a GraphQL client by shop domain
 */
export async function createClientByDomain(
  shopDomain: string
): Promise<ShopifyGraphQLClient> {
  const store = await prisma.connectedStore.findUnique({
    where: { shopDomain },
  });

  if (!store) {
    throw new Error(`Store not found: ${shopDomain}`);
  }

  const token = decrypt(store.accessToken);
  return new ShopifyGraphQLClient(store.shopDomain, token);
}

/**
 * Get source and destination clients for a sync rule
 */
export async function getClientsForSyncRule(syncRuleId: string): Promise<{
  sourceClient: ShopifyGraphQLClient;
  destClient: ShopifyGraphQLClient;
}> {
  const rule = await prisma.syncRule.findUnique({
    where: { id: syncRuleId },
    include: { sourceStore: true, destStore: true },
  });

  if (!rule) {
    throw new Error(`Sync rule not found: ${syncRuleId}`);
  }

  const sourceToken = decrypt(rule.sourceStore.accessToken);
  const destToken = decrypt(rule.destStore.accessToken);

  return {
    sourceClient: new ShopifyGraphQLClient(
      rule.sourceStore.shopDomain,
      sourceToken
    ),
    destClient: new ShopifyGraphQLClient(
      rule.destStore.shopDomain,
      destToken
    ),
  };
}
