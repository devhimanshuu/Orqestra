/**
 * Run memory.
 *
 * Phase 2 memory is intentionally small: a per-run, in-process store keyed by
 * scope, bounded per key, discarded when the run ends. No database writes, no
 * cross-run leakage. Session/persistent scopes are refused at compile time, so
 * this store is the only memory implementation the runtime can reach.
 *
 * The store exists as a seam: durable memory (Phase 3+) replaces this class
 * without touching the memory executor.
 */

export interface MemoryEntry {
  at: string;
  nodeId: string;
  value: unknown;
}

export interface SessionMemoryStore {
  /** Appends an entry to a scope-keyed store and returns the current window. */
  append(key: string, entry: MemoryEntry, maxItems: number): Promise<MemoryEntry[]>;
  list(key: string): Promise<MemoryEntry[]>;
  keys(): Promise<string[]>;
  size(): Promise<number>;
  /** Snapshots values for a given key, for debugging / metadata. */
  snapshot(key: string): Promise<unknown[]>;
}

export class RunMemoryStore {
  private readonly entries = new Map<string, MemoryEntry[]>();

  /** Appends and trims to `maxItems`; returns the current window (oldest first). */
  async append(key: string, entry: MemoryEntry, maxItems: number): Promise<MemoryEntry[]> {
    const existing = this.entries.get(key) ?? [];
    const next = [...existing, entry];
    const trimmed = next.length > maxItems ? next.slice(next.length - maxItems) : next;
    this.entries.set(key, trimmed);
    return trimmed;
  }

  async list(key: string): Promise<MemoryEntry[]> {
    return [...(this.entries.get(key) ?? [])];
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async size(): Promise<number> {
    let total = 0;
    for (const bucket of this.entries.values()) {
      total += bucket.length;
    }
    return total;
  }

  /** Serializable snapshot (run metadata / debugging), values included. */
  async snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const [key, bucket] of this.entries) {
      result[key] = bucket.map((entry) => entry.value);
    }
    return result;
  }
}

/**
 * Redis-backed session and persistent memory stores.
 * Uses D1-like persistent storage scoped to user sessions.
 * Session scope: persists across runs within a single Freebuff session
 * (e.g. OpenAI-style conversation history).
 * Persistent scope: persists across sessions (user-level long-term memory).
 */
export class RedisMemoryStore {
  private readonly redis: import("ioredis").Redis;
  private readonly ttlSeconds: number;

  constructor(redis?: import("ioredis").Redis, ttlSeconds = 86400) {
    this.redis = redis ?? getRedis();
    this.ttlSeconds = ttlSeconds;
  }

  async append(key: string, entry: MemoryEntry, maxItems: number): Promise<MemoryEntry[]> {
    const existingRaw = await this.redis.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const next = [...existing, entry];
    const trimmed = next.length > maxItems ? next.slice(next.length - maxItems) : next;
    await this.redis.set(key, JSON.stringify(trimmed));
    await this.redis.expire(key, this.ttlSeconds);
    return trimmed;
  }

  async list(key: string): Promise<MemoryEntry[]> {
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : [];
  }

  async keys(): Promise<string[]> {
    const allKeys = await this.redis.keys("memory:*");
    return allKeys;
  }

  async size(): Promise<number> {
    const allKeys = await this.keys();
    let total = 0;
    for (const k of allKeys) {
      const raw = await this.redis.get(k);
      if (raw) {
        total += JSON.parse(raw).length;
      }
    }
    return total;
  }

  async snapshot(key: string): Promise<unknown[]> {
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw).map((e: MemoryEntry) => e.value) : [];
  }
}

import { getRedis } from "../../../lib/redis/connection";
export { getRedis };
