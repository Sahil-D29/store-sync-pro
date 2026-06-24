import type { AuthMethod } from "@prisma/client";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import { validateStoreToken } from "./shopify-client.server";

/**
 * Resolve the "account" a shop belongs to. An account is identified by the
 * base/source store's shopDomain. A base store owns itself; a destination
 * inherits its base store's domain. A shop with no record yet is its own account
 * (it will be auto-registered as a base store on first auth).
 */
export async function getAccountShop(shopDomain: string): Promise<string> {
  shopDomain = normalizeDomain(shopDomain);
  const store = await prisma.connectedStore.findUnique({
    where: { shopDomain },
    select: { isBaseStore: true, ownerShop: true },
  });
  if (!store) return shopDomain;
  if (store.isBaseStore) return shopDomain;
  return store.ownerShop || shopDomain;
}

/**
 * Ensure the authenticated shop has a ConnectedStore row. Called from afterAuth
 * so the source store is registered automatically (no manual "register base"
 * step). A brand-new shop becomes its own base store / account. An existing
 * store keeps its role (a destination of another account stays a destination)
 * and just gets its access token + currency refreshed.
 */
export async function ensureStoreRegistered(session: {
  shop: string;
  accessToken?: string;
}): Promise<void> {
  const shopDomain = normalizeDomain(session.shop);
  const token = session.accessToken;

  const existing = await prisma.connectedStore.findUnique({
    where: { shopDomain },
  });

  if (existing) {
    // Refresh the stored token (keeps source-store syncs working) and ensure a
    // legacy base row has its ownerShop set. Never change an existing role.
    await prisma.connectedStore.update({
      where: { shopDomain },
      data: {
        ...(token ? { accessToken: encrypt(token) } : {}),
        status: existing.status === "DISCONNECTED" ? "DISCONNECTED" : "ACTIVE",
        ownerShop:
          existing.ownerShop ||
          (existing.isBaseStore ? shopDomain : existing.ownerShop),
      },
    });
    return;
  }

  // Brand-new shop → register as its own base store (its own account).
  let shopName: string | undefined;
  let currencyCode: string | undefined;
  if (token) {
    const validation = await validateStoreToken(shopDomain, token);
    if (validation.valid) {
      shopName = validation.shopName;
      currencyCode = validation.currencyCode;
    }
  }

  await prisma.connectedStore.create({
    data: {
      shopDomain,
      ownerShop: shopDomain,
      accessToken: encrypt(token || ""),
      shopName,
      currencyCode: currencyCode || "USD",
      isBaseStore: true,
      authMethod: "OAUTH" as AuthMethod,
      status: "ACTIVE",
    },
  });
}

/**
 * Connect a destination store via OAuth (looks up the Shopify session created when
 * the merchant installed the app on the destination store)
 */
export async function connectStoreViaOAuth(
  shopDomain: string,
  baseStoreShopDomain: string
): Promise<{
  success: boolean;
  store?: any;
  error?: string;
}> {
  shopDomain = normalizeDomain(shopDomain);
  const ownerShop = await getAccountShop(baseStoreShopDomain);

  if (shopDomain === ownerShop) {
    return { success: false, error: "Cannot connect the source store as a destination" };
  }

  // The destination store may already have a ConnectedStore row because opening
  // the app there auto-registers it as its own base store. That's fine — we
  // convert it into a destination of the connecting account. Only block if it's
  // a base store that already has its own sync setup under a different account.
  const existing = await prisma.connectedStore.findUnique({
    where: { shopDomain },
    select: { isBaseStore: true, ownerShop: true, _count: { select: { syncRulesAsSource: true } } },
  });

  if (
    existing &&
    existing.isBaseStore &&
    existing.ownerShop &&
    existing.ownerShop !== ownerShop &&
    existing._count.syncRulesAsSource > 0
  ) {
    return {
      success: false,
      error: `${shopDomain} is already set up as its own source store with sync rules. Remove that setup before connecting it as a destination.`,
    };
  }

  // Look up the offline session created by Shopify OAuth when the app was installed
  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    orderBy: { id: "desc" },
  });

  if (!session || !session.accessToken) {
    return {
      success: false,
      error: `No session found for ${shopDomain}. Please install the app on that store first, then come back here and click "Verify & Connect".`,
    };
  }

  // Validate the token works
  const validation = await validateStoreToken(shopDomain, session.accessToken);
  if (!validation.valid) {
    return {
      success: false,
      error: `Session token is invalid or expired: ${validation.error}. Try reinstalling the app on ${shopDomain}.`,
    };
  }

  // Encrypt and store
  const encryptedToken = encrypt(session.accessToken);

  const store = await prisma.connectedStore.upsert({
    where: { shopDomain },
    update: {
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "OAUTH" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
      ownerShop,
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "OAUTH" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
      ownerShop,
    },
  });

  return { success: true, store };
}

/**
 * Connect a new destination store (via custom token - legacy fallback)
 */
export async function connectStoreWithToken(
  shopDomain: string,
  accessToken: string,
  baseStoreShopDomain: string
): Promise<{
  success: boolean;
  store?: any;
  error?: string;
}> {
  // Normalize domain
  shopDomain = normalizeDomain(shopDomain);
  const ownerShop = await getAccountShop(baseStoreShopDomain);

  if (shopDomain === ownerShop) {
    return { success: false, error: "Cannot connect the source store as a destination" };
  }

  // Validate the token
  const validation = await validateStoreToken(shopDomain, accessToken);
  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid token: ${validation.error}`,
    };
  }

  // Encrypt and store
  const encryptedToken = encrypt(accessToken);

  const store = await prisma.connectedStore.upsert({
    where: { shopDomain },
    update: {
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "CUSTOM_TOKEN" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
      ownerShop,
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "CUSTOM_TOKEN" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
      ownerShop,
    },
  });

  return { success: true, store };
}

/**
 * Register the base (source) store from the Shopify OAuth session
 */
export async function registerBaseStore(
  shopDomain: string,
  accessToken: string,
  shopName?: string
): Promise<any> {
  shopDomain = normalizeDomain(shopDomain);
  const encryptedToken = encrypt(accessToken);

  // A base store is its own account (ownerShop = self). Do NOT touch other
  // accounts' base stores — each merchant has their own isolated base store.
  return prisma.connectedStore.upsert({
    where: { shopDomain },
    update: {
      accessToken: encryptedToken,
      shopName,
      isBaseStore: true,
      ownerShop: shopDomain,
      authMethod: "OAUTH",
      status: "ACTIVE",
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName,
      isBaseStore: true,
      ownerShop: shopDomain,
      authMethod: "OAUTH",
      status: "ACTIVE",
    },
  });
}

/**
 * Disconnect a store
 */
export async function disconnectStore(storeId: string): Promise<void> {
  const store = await prisma.connectedStore.findUnique({
    where: { id: storeId },
  });

  if (!store) throw new Error("Store not found");
  if (store.isBaseStore) throw new Error("Cannot disconnect the base store");

  // Deactivate all sync rules involving this store
  await prisma.syncRule.updateMany({
    where: {
      OR: [{ sourceStoreId: storeId }, { destStoreId: storeId }],
    },
    data: { isActive: false },
  });

  await prisma.connectedStore.update({
    where: { id: storeId },
    data: { status: "DISCONNECTED" },
  });
}

/**
 * Get all connected stores for a single account (ownerShop).
 */
export async function getConnectedStores(ownerShop: string) {
  return prisma.connectedStore.findMany({
    where: { ownerShop, status: { not: "DISCONNECTED" } },
    orderBy: [{ isBaseStore: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      shopDomain: true,
      shopName: true,
      currencyCode: true,
      isBaseStore: true,
      authMethod: true,
      status: true,
      lastSyncAt: true,
      createdAt: true,
      _count: {
        select: {
          syncRulesAsDest: { where: { isActive: true } },
          productMappingsAsSource: { where: { status: "SYNCED" } },
        },
      },
    },
  });
}

/**
 * Get the base (source) store for an account.
 */
export async function getBaseStore(ownerShop: string) {
  return prisma.connectedStore.findFirst({
    where: { ownerShop, isBaseStore: true, status: "ACTIVE" },
  });
}

/**
 * Get destination stores for an account.
 */
export async function getDestinationStores(ownerShop: string) {
  return prisma.connectedStore.findMany({
    where: { ownerShop, isBaseStore: false, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Refresh store connection (re-validate token)
 */
export async function refreshStoreConnection(storeId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const store = await prisma.connectedStore.findUnique({
    where: { id: storeId },
  });

  if (!store) return { success: false, error: "Store not found" };

  // First, try to get a fresh token from the Session table (handles token rotation)
  const offlineSession = await prisma.session.findFirst({
    where: {
      shop: store.shopDomain,
      isOnline: false,
    },
    orderBy: { id: "desc" },
  });

  let tokenToValidate = decrypt(store.accessToken);

  // If we found a session token that differs from stored, try the session token first
  if (offlineSession?.accessToken && offlineSession.accessToken !== tokenToValidate) {
    const sessionValidation = await validateStoreToken(store.shopDomain, offlineSession.accessToken);
    if (sessionValidation.valid) {
      // Session token works — update the stored token
      const encryptedToken = encrypt(offlineSession.accessToken);
      await prisma.connectedStore.update({
        where: { id: storeId },
        data: {
          accessToken: encryptedToken,
          status: "ACTIVE",
          shopName: sessionValidation.shopName || store.shopName,
          currencyCode: sessionValidation.currencyCode || store.currencyCode,
        },
      });
      return { success: true };
    }
  }

  // Fall back to validating the stored token
  const validation = await validateStoreToken(store.shopDomain, tokenToValidate);

  if (!validation.valid) {
    await prisma.connectedStore.update({
      where: { id: storeId },
      data: { status: "ERROR" },
    });
    return { success: false, error: validation.error };
  }

  await prisma.connectedStore.update({
    where: { id: storeId },
    data: {
      status: "ACTIVE",
      shopName: validation.shopName || store.shopName,
      currencyCode: validation.currencyCode || store.currencyCode,
    },
  });

  return { success: true };
}

function normalizeDomain(domain: string): string {
  domain = domain.trim().toLowerCase();
  // Remove protocol
  domain = domain.replace(/^https?:\/\//, "");
  // Remove trailing slash
  domain = domain.replace(/\/$/, "");
  // Add .myshopify.com if not present
  if (!domain.includes(".")) {
    domain = `${domain}.myshopify.com`;
  }
  return domain;
}
