import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureStoreRegistered } from "./services/store-management.server";
import { withDbRetry } from "./utils/db-retry.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // Offline tokens are intentionally NON-expiring: destination stores are
    // never opened embedded, so an expiring token would silently break syncs.
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Auto-register the authenticated shop so the source store is set up
      // without a manual step, and keep its offline token fresh.
      try {
        await ensureStoreRegistered(session);
      } catch (e) {
        console.error("[afterAuth] ensureStoreRegistered failed:", (e as Error).message);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
// Wrap authenticate.admin so a brief Postgres restart (the session lookup hits
// the DB) retries instead of surfacing an "Application Error" to the merchant.
// Redirect Responses thrown for re-auth aren't transient, so they propagate
// immediately. All other methods (e.g. webhook) pass through unchanged.
export const authenticate: typeof shopify.authenticate = new Proxy(
  shopify.authenticate,
  {
    get(target, prop, receiver) {
      if (prop === "admin") {
        return (request: Request) =>
          withDbRetry(() => target.admin(request));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }
);
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
