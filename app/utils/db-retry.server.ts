/**
 * Retry a database operation on transient connection errors.
 *
 * Hosted Postgres (Railway/Fly/etc.) occasionally drops idle connections or
 * briefly refuses new ones, which surfaces as Prisma errors P1001 (can't reach
 * DB), P1017 (server closed the connection), or generic connection-pool
 * timeouts. A single retry after a short backoff clears the vast majority of
 * these without bubbling an "Unexpected Server Error" up to the loader.
 */
const TRANSIENT_CODES = ["P1001", "P1002", "P1008", "P1017", "P2024"];

function isTransient(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && TRANSIENT_CODES.includes(code)) return true;
  const message = (error as Error)?.message?.toLowerCase() ?? "";
  return (
    message.includes("can't reach database") ||
    message.includes("connection") ||
    message.includes("timed out") ||
    message.includes("econnreset")
  );
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  retries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries && isTransient(error)) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
