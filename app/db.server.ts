import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

// Reuse a single PrismaClient across hot-reloads in dev AND across module
// re-imports in production. Creating a new client per import leaks DB
// connections and exhausts Postgres connection limits on hosts like Railway —
// a common cause of intermittent "Unexpected Server Error" loader failures.
const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: ["warn", "error"],
  });

global.prismaGlobal = prisma;

export default prisma;
