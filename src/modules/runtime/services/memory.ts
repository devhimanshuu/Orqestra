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

export class RunMemoryStore {
  private readonly entries = new Map<string, MemoryEntry[]>();

  /** Appends and trims to `maxItems`; returns the current window (oldest first). */
  append(key: string, entry: MemoryEntry, maxItems: number): MemoryEntry[] {
    const existing = this.entries.get(key) ?? [];
    const next = [...existing, entry];
    const trimmed = next.length > maxItems ? next.slice(next.length - maxItems) : next;
    this.entries.set(key, trimmed);
    return trimmed;
  }

  list(key: string): MemoryEntry[] {
    return [...(this.entries.get(key) ?? [])];
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    let total = 0;
    for (const bucket of this.entries.values()) {
      total += bucket.length;
    }
    return total;
  }

  /** Serializable snapshot (run metadata / debugging), values included. */
  snapshot(): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (const [key, bucket] of this.entries) {
      result[key] = bucket.map((entry) => entry.value);
    }
    return result;
  }
}
