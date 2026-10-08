import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";

/**
 * Prisma singleton.
 *
 * Created lazily so that merely importing a module never reads env vars or
 * opens sockets — fail-fast validation happens once in src/instrumentation.ts.
 *
 * Neon: the WebSocket-based Pool (not the HTTP `neon()` driver) is required
 * because repositories use interactive `$transaction([...])` calls, which the
 * HTTP driver does not support. The pooler endpoint mandates TLS; the Neon
 * driver negotiates it automatically.
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaNeon({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

type PrismaGlobal = { __orqestraPrisma?: PrismaClient };

const globalForPrisma = globalThis as unknown as PrismaGlobal;

export function getPrisma(): PrismaClient {
  if (globalForPrisma.__orqestraPrisma === undefined) {
    globalForPrisma.__orqestraPrisma = createPrismaClient();
    logger.debug("prisma client initialized");
  }
  return globalForPrisma.__orqestraPrisma;
}
