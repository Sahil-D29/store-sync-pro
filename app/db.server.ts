import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

/**
 * Cap the connection pool so the web server AND the BullMQ worker (two separate
 * processes, each with their own pool) don't exhaust the hosted Postgres
 * connection limit — the root cause of the intermittent "Application Error" /
 * transient connection failures on Railway. Appends connection_limit/pool_timeout
 * to DATABASE_URL unless the URL already specifies them.
 */
function buildDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return url;
  if (url.includes("connection_limit") || url.startsWith("file:")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=5&pool_timeout=20`;
}

// Reuse a single PrismaClient across hot-reloads in dev AND across module
// re-imports in production. Creating a new client per import leaks DB
// connections and exhausts Postgres connection limits on hosts like Railway.
const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: ["warn", "error"],
    datasources: { db: { url: buildDatabaseUrl() } },
  });

global.prismaGlobal = prisma;

export default prisma;
