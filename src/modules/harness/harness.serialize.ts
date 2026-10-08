import { createHash } from "node:crypto";
import { harnessDefinitionSchema, type HarnessDefinition } from "./harness.schema";
import { validateHarnessDefinition, type HarnessValidationResult } from "./harness.validation";

/**
 * Serialization & content hashing.
 *
 * Canonical form = JSON with recursively sorted object keys and nodes/edges
 * sorted by id. Two definitions that describe the same harness produce the
 * same canonical string and therefore the same SHA-256 content hash, no
 * matter how they were authored or stored.
 *
 * The canonical string is also what gets persisted as HarnessVersion.definition
 * — stored versions are byte-stable, which makes diffs, dedup, and
 * reproducibility checks trivial.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Stable, order-independent JSON string for a *valid* definition. */
export function serializeHarnessDefinition(definition: HarnessDefinition): string {
  const ordered = {
    ...definition,
    nodes: [...definition.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...definition.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return JSON.stringify(canonicalize(ordered));
}

/** SHA-256 (hex) of the canonical serialization. */
export function hashHarnessDefinition(definition: HarnessDefinition): string {
  return createHash("sha256").update(serializeHarnessDefinition(definition), "utf8").digest("hex");
}

/**
 * Parse + validate unknown data (e.g. API input or a stored row) into a
 * harness definition. Returns the full validation result.
 */
export function parseHarnessDefinition(input: unknown): HarnessValidationResult {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return {
        ok: false,
        definition: null,
        issues: [{ code: "INVALID_SCHEMA", message: "Definition is not valid JSON" }],
      };
    }
  }
  return validateHarnessDefinition(input);
}

/** Throwing variant used where an invalid definition is a programming error. */
export function assertHarnessDefinition(input: unknown): HarnessDefinition {
  const result = parseHarnessDefinition(input);
  if (!result.ok) {
    const summary = result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`Invalid harness definition: ${summary}`);
  }
  return result.definition;
}

/** Raw structural parse (schema only, no graph rules) — used by persistence mappers. */
export function safeParseDefinitionSchema(input: unknown) {
  return harnessDefinitionSchema.safeParse(input);
}
