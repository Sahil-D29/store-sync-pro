import type { AuthMethod } from "@prisma/client";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import { validateStoreToken } from "./shopify-client.server";

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

  if (shopDomain === normalizeDomain(baseStoreShopDomain)) {
    return { success: false, error: "Cannot connect the base store as a destination" };
  }

  // Check if already connected
  const existing = await prisma.connectedStore.findUnique({
    where: { shopDomain },
  });

  if (existing && existing.status !== "DISCONNECTED") {
    return { success: false, error: "Store is already connected" };
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
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "OAUTH" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
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

  // Check if already connected
  const existing = await prisma.connectedStore.findUnique({
    where: { shopDomain },
  });

  if (existing && existing.status !== "DISCONNECTED") {
    return { success: false, error: "Store is already connected" };
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
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName: validation.shopName,
      currencyCode: validation.currencyCode || "USD",
      authMethod: "CUSTOM_TOKEN" as AuthMethod,
      status: "ACTIVE",
      isBaseStore: false,
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

  // Unset any previous base store
  await prisma.connectedStore.updateMany({
    where: { isBaseStore: true },
    data: { isBaseStore: false },
  });

  return prisma.connectedStore.upsert({
    where: { shopDomain },
    update: {
      accessToken: encryptedToken,
      shopName,
      isBaseStore: true,
      authMethod: "OAUTH",
      status: "ACTIVE",
    },
    create: {
      shopDomain,
      accessToken: encryptedToken,
      shopName,
      isBaseStore: true,
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
 * Get all connected stores
 */
export async function getConnectedStores() {
  return prisma.connectedStore.findMany({
    where: { status: { not: "DISCONNECTED" } },
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
 * Get base store
 */
export async function getBaseStore() {
  return prisma.connectedStore.findFirst({
    where: { isBaseStore: true, status: "ACTIVE" },
  });
}

/**
 * Get destination stores
 */
export async function getDestinationStores() {
  return prisma.connectedStore.findMany({
    where: { isBaseStore: false, status: "ACTIVE" },
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

  const token = decrypt(store.accessToken);
  const validation = await validateStoreToken(store.shopDomain, token);

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
