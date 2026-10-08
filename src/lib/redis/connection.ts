import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";

/**
 * Redis connection layer.
 *
 * One shared client for direct operations (health checks, future cache use)
 * plus a URL parser reused by BullMQ queue/worker construction so queue
 * connections never bypass this module.
 */
import Redis, { type RedisOptions } from "ioredis";

export { Redis };
export type { RedisOptions };

export interface ParsedRedisUrl {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean;
}

/** Parse redis:// / rediss:// URLs into ioredis-compatible options. */
export function parseRedisUrl(url: string): ParsedRedisUrl {
  const parsed = new URL(url);
  const isUnix = parsed.protocol === "unix:";
  const options: ParsedRedisUrl = {
    host: isUnix ? url : parsed.hostname || "127.0.0.1",
    port: isUnix ? 0 : Number(parsed.port || 6379),
  };
  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username) {
    options.username = decodeURIComponent(parsed.username);
  }
  const db = parsed.pathname.replace(/^\//, "");
  if (db) {
    const dbNumber = Number(db);
    if (!Number.isNaN(dbNumber)) {
      options.db = dbNumber;
    }
  }
  if (parsed.protocol === "rediss:") {
    options.tls = true;
  }
  return options;
}

export function buildRedisOptions(
  url: string,
  overrides: Partial<RedisOptions> = {},
): RedisOptions {
  const parsed = parseRedisUrl(url);
  return {
    host: parsed.host,
    port: parsed.port,
    ...(parsed.username !== undefined ? { username: parsed.username } : {}),
    ...(parsed.password !== undefined ? { password: parsed.password } : {}),
    ...(parsed.db !== undefined ? { db: parsed.db } : {}),
    ...(parsed.tls === true ? { tls: {} } : {}),
    // Fail fast instead of queueing commands while Redis is down.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    // Callers (e.g. BullMQ workers) can override — overrides win.
    ...overrides,
  };
}

type RedisGlobal = { __orqestraRedis?: Redis };

const globalForRedis = globalThis as unknown as RedisGlobal;

/** Normalizes ioredis errors — their `message` is often empty. */
function redisErrorFields(error: Error): Record<string, unknown> {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    name: error.name,
    message: error.message === "" ? "connection failed" : error.message,
    ...(code !== undefined ? { code } : {}),
  };
}

/** Creates a dedicated Redis client (callers own its lifecycle). */
export function createRedisClient(overrides: Partial<RedisOptions> = {}): Redis {
  const url = getEnv().REDIS_URL;
  const client = new Redis(url, buildRedisOptions(url, overrides));
  // ioredis emits 'error' events; without a listener they become uncaught
  // exceptions. Connection problems are surfaced via health checks instead.
  client.on("error", (error: Error) => {
    logger.warn("redis connection error", redisErrorFields(error));
  });
  return client;
}

/**
 * Connection for BullMQ queue producers/workers.
 * BullMQ requires maxRetriesPerRequest: null so Redis commands are not
 * aborted while a blocking connection waits for work.
 */
export function createBullConnection(): Redis {
  return createRedisClient({ maxRetriesPerRequest: null, enableOfflineQueue: true });
}

function waitForReady(client: Redis, ms: number): Promise<void> {
  if (client.status === "ready") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      reject(new Error(`redis was not ready within ${ms}ms`));
    }, ms);
    client.once("ready", onReady);
  });
}

/**
 * Timed Redis ping used by health checks.
 *
 * The shared client fails fast (`enableOfflineQueue: false`) and is created
 * lazily, so the very first ping can race the initial connection — wait for
 * `ready` within the budget instead of reporting a false negative.
 */
export async function pingRedis(timeoutMs = 3_000): Promise<number> {
  const client = getRedis();
  const startedAt = performance.now();
  await waitForReady(client, timeoutMs);
  await client.ping();
  return Math.round(performance.now() - startedAt);
}

/** Shared client for direct commands (health checks, future caching). */
export function getRedis(): Redis {
  if (globalForRedis.__orqestraRedis === undefined) {
    const client = createRedisClient();
    client.on("ready", () => {
      logger.info("redis ready");
    });
    globalForRedis.__orqestraRedis = client;
  }
  return globalForRedis.__orqestraRedis;
}

export async function closeRedis(): Promise<void> {
  const client = globalForRedis.__orqestraRedis;
  if (client) {
    globalForRedis.__orqestraRedis = undefined as unknown as Redis;
    await client.quit().catch(() => client.disconnect());
  }
}
