import { createHash } from "node:crypto";

/**
 * Canonical hashing for evaluation snapshots.
 *
 * Datasets, evaluator revisions and batch snapshots are all hashed the same way
 * harness definitions are: recursively sorted object keys, `undefined` dropped,
 * then SHA-256. Two snapshots that mean the same thing hash the same, so a
 * batch can prove exactly which dataset/evaluator revision it ran.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (child !== undefined) {
        out[key] = canonicalize(child);
      }
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
