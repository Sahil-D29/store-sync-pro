/**
 * Retry a database operation while the Postgres server is briefly unavailable.
 *
 * On Railway the managed Postgres instance occasionally restarts/cycles. During
 * its startup window it rejects connections with errors like:
 *   - "FATAL: the database system is not yet accepting connections"
 *   - "the database system is starting up"
 *   - P1001 (can't reach DB) / P1017 (server closed the connection)
 *   - PrismaClientUnknownRequestError / connection-pool timeouts
 * These windows can last several seconds, so a couple of 150ms retries isn't
 * enough — we retry with exponential backoff for up to ~12s so requests made
 * during a restart WAIT for the DB to come back instead of surfacing an
 * "Application Error" to the merchant.
 */
const TRANSIENT_CODES = ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028"];

const TRANSIENT_MESSAGES = [
  "not yet accepting connections",
  "the database system is starting up",
  "the database system is shutting down",
  "can't reach database",
  "connection",
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "terminating connection",
  "server closed the connection",
];

function isTransient(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && TRANSIENT_CODES.includes(code)) return true;
  // Prisma wraps DB startup errors in PrismaClientUnknownRequestError.
  const name = (error as { name?: string })?.name ?? "";
  if (name === "PrismaClientUnknownRequestError") return true;
  const message = (error as Error)?.message?.toLowerCase() ?? "";
  return TRANSIENT_MESSAGES.some((m) => message.includes(m));
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  retries = 7
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries && isTransient(error)) {
        // 200, 400, 800, 1600, 3000, 3000, 3000 ms — ~12s total, capped at 3s.
        const delay = Math.min(200 * 2 ** attempt, 3000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
