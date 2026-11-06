import assert from "node:assert/strict";
import {
  createShopifyAdminHttpError,
  ShopifyHttpError,
} from "../app/utils/shopify-api-error.server";
import { ShopifyGraphQLClient } from "../app/services/shopify-client.server";

const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
const capturedLogs: string[] = [];

try {
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  const response = new Response("sensitive response body", {
    status: 403,
    statusText: "Forbidden",
    headers: { "x-request-id": "request-403" },
  });
  const error = createShopifyAdminHttpError(response, {
    shopDomain: "example.myshopify.com",
    apiSurface: "admin_graphql",
    operation: "graphql_query",
  });

  assert.ok(error instanceof ShopifyHttpError);
  assert.equal(error.status, 403);
  assert.equal(error.requestId, "request-403");
  assert.equal(error.retryable, false);
  assert.match(error.message, /may have been blocked by the app IP allowlist/i);
  assert.match(error.message, /request-403/);

  assert.equal(capturedLogs.length, 1);
  assert.match(capturedLogs[0], /shopify_ip_allowlist_rejected/);
  assert.match(capturedLogs[0], /example\.myshopify\.com/);
  assert.match(capturedLogs[0], /admin_graphql/);
  assert.match(capturedLogs[0], /request-403/);
  assert.doesNotMatch(capturedLogs[0], /sensitive response body/);
  assert.doesNotMatch(capturedLogs[0], /access token/i);

  const unauthorized = createShopifyAdminHttpError(
    new Response(null, {
      status: 401,
      statusText: "Unauthorized",
      headers: { "x-request-id": "request-401" },
    }),
    {
      shopDomain: "example.myshopify.com",
      apiSurface: "admin_rest",
      operation: "rest_get",
    }
  );

  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.retryable, false);
  assert.match(unauthorized.message, /access token is invalid or expired/i);
  assert.doesNotMatch(unauthorized.message, /allowlist/i);
  assert.equal(capturedLogs.length, 1, "401 responses must not emit allowlist alerts");

  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, {
      status: 403,
      statusText: "Forbidden",
      headers: { "x-request-id": "client-request-403" },
    });
  };

  const client = new ShopifyGraphQLClient(
    "example.myshopify.com",
    "test-token-that-must-not-be-logged"
  );
  await assert.rejects(
    () => client.queryWithRetry("query Test { shop { id } }"),
    (clientError: unknown) =>
      clientError instanceof ShopifyHttpError &&
      clientError.status === 403 &&
      clientError.retryable === false
  );
  assert.equal(requestCount, 1, "403 responses must not be retried");
  assert.doesNotMatch(
    capturedLogs.join("\n"),
    /test-token-that-must-not-be-logged/
  );

  originalConsoleError("Shopify IP allowlist logging tests passed.");
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
}
