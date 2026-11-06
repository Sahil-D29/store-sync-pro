import { createLogger } from "./logger.server";

const log = createLogger("ShopifyAdminApi");

export type ShopifyApiSurface = "admin_graphql" | "admin_rest";

type ShopifyHttpErrorContext = {
  shopDomain: string;
  apiSurface: ShopifyApiSurface;
  operation: string;
};

export class ShopifyHttpError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      requestId: string | null;
      retryable: boolean;
    }
  ) {
    super(message);
    this.name = "ShopifyHttpError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable;
  }
}

function getRequestId(response: Response): string | null {
  return response.headers.get("x-request-id");
}

/**
 * Build a safe error for failed Shopify Admin API responses.
 *
 * A 403 can be caused by an IP allowlist policy, so it must not be presented as
 * an expired token. The structured log deliberately excludes tokens, request
 * payloads, and response bodies.
 */
export function createShopifyAdminHttpError(
  response: Response,
  context: ShopifyHttpErrorContext
): ShopifyHttpError {
  const requestId = getRequestId(response);
  const requestIdSuffix = requestId ? ` Request ID: ${requestId}.` : "";

  if (response.status === 403) {
    log.error("Shopify Admin API request rejected with 403", {
      event: "shopify_ip_allowlist_rejected",
      occurredAt: new Date().toISOString(),
      status: response.status,
      shopDomain: context.shopDomain,
      apiSurface: context.apiSurface,
      operation: context.operation,
      requestId,
    });

    return new ShopifyHttpError(
      `Shopify Admin API error: 403 Forbidden for ${context.shopDomain}. The request may have been blocked by the app IP allowlist; check the Dev Dashboard API logs and allowed networks.${requestIdSuffix}`,
      { status: response.status, requestId, retryable: false }
    );
  }

  if (response.status === 401) {
    return new ShopifyHttpError(
      `Shopify Admin API error: 401 Unauthorized for ${context.shopDomain}. The access token is invalid or expired; reconnect this store to mint a fresh token.${requestIdSuffix}`,
      { status: response.status, requestId, retryable: false }
    );
  }

  return new ShopifyHttpError(
    `Shopify Admin API error: ${response.status} ${response.statusText} (${context.shopDomain}).${requestIdSuffix}`,
    {
      status: response.status,
      requestId,
      retryable: response.status >= 500,
    }
  );
}
