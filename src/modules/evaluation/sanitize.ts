/**
 * Sanitisation for anything that leaves the platform.
 *
 * Traces, tool arguments and model responses are the most likely place for a
 * credential to end up: an agent that fetches a URL with a key in the query
 * string, a tool result that echoes an Authorization header, an error message
 * quoting a provider token. Export is therefore filtered structurally rather
 * than trusted:
 *
 *  - object **keys** matching a sensitive pattern are redacted by name;
 *  - obvious bearer/API-key **shapes** inside strings are redacted by value;
 *  - depth, string length and array length are capped so an export cannot grow
 *    unbounded (or blow up a browser rendering it).
 *
 * The output is JSON-safe: Dates become ISO strings, functions and symbols are
 * dropped, and cycles are replaced with a marker instead of throwing.
 */

import type { RunDetail } from "@/modules/runtime/run.types";

export const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|credential|private[-_]?key|client[-_]?secret|session[-_]?id|bearer)/i;

/** Value-level patterns for secrets that appear inside otherwise harmless text. */
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, "Bearer [redacted]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9]{12,}\b/g, "[redacted-secret]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-secret]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]"],
  // `key=value` / `key: value` assignments, in URLs and in free text. The word
  // boundaries keep ordinary words (tokenCount=5, keys=3) untouched.
  [
    /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|pass(?:word|phrase)?|secret|token|key)\s*[=:]\s*)([^\s,;"'&]+)/gi,
    "$1[redacted]",
  ],
  [/([?&](?:api[_-]?key|access[_-]?token|key|token|password)=)[^&\s"']+/gi, "$1[redacted]"],
];

export interface SanitizeOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayItems?: number;
  maxKeys?: number;
}

const DEFAULTS: Required<SanitizeOptions> = {
  maxDepth: 12,
  maxStringLength: 20_000,
  maxArrayItems: 500,
  maxKeys: 200,
};

export function redactSecretsInText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Deep-copies a value, redacting sensitive keys and secret-looking strings. */
export function sanitizeValue(value: unknown, options: SanitizeOptions = {}): unknown {
  const limits = { ...DEFAULTS, ...options };
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) {
      return null;
    }
    if (depth > limits.maxDepth) {
      return "[truncated: depth]";
    }
    if (typeof node === "string") {
      const redacted = redactSecretsInText(node);
      return redacted.length > limits.maxStringLength
        ? `${redacted.slice(0, limits.maxStringLength)}…[truncated]`
        : redacted;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      return node;
    }
    if (typeof node === "bigint") {
      return node.toString();
    }
    if (typeof node === "function" || typeof node === "symbol") {
      return undefined;
    }
    if (node instanceof Date) {
      return node.toISOString();
    }
    if (node instanceof Error) {
      return { name: node.name, message: redactSecretsInText(node.message) };
    }
    if (typeof node === "object") {
      if (seen.has(node)) {
        return "[circular]";
      }
      seen.add(node);
      if (Array.isArray(node)) {
        const items = node.slice(0, limits.maxArrayItems).map((item) => walk(item, depth + 1));
        if (node.length > limits.maxArrayItems) {
          items.push(`[truncated: ${node.length - limits.maxArrayItems} more items]`);
        }
        return items;
      }
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, child] of Object.entries(record)) {
        if (count >= limits.maxKeys) {
          out["[truncated]"] = `${Object.keys(record).length - count} more keys`;
          break;
        }
        count += 1;
        out[key] = isSensitiveKey(key) ? REDACTED : walk(child, depth + 1);
      }
      return out;
    }
    return String(node);
  };

  return walk(value, 0);
}

/** A short, redacted error message suitable for an API response. */
export function safeErrorMessage(error: unknown, fallback = "Unexpected error"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = redactSecretsInText(message);
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

// ------------------------------------------------------------------------------
// Exports
// ------------------------------------------------------------------------------

export interface RunTraceExport {
  schemaVersion: 1;
  kind: "orqestra.run-trace";
  exportedAt: string;
  sanitized: true;
  run: {
    id: string;
    status: string;
    attempt: number;
    retryOfRunId: string | null;
    input: unknown;
    output: unknown;
    error: unknown;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    latencyMs: number | null;
    tokenUsage: unknown;
    cost: number | null;
    costKind: "estimated";
    metadata: unknown;
  };
  harness: { id: string; name: string; slug: string; versionLabel: number | null };
  agent: { id: string; name: string } | null;
  steps: Array<{
    index: number;
    nodeId: string;
    nodeType: string;
    nodeLabel: string;
    status: string;
    iteration: number | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    input: unknown;
    output: unknown;
    error: unknown;
    metadata: unknown;
  }>;
  events: Array<{ seq: number; type: string; at: string; payload: unknown }>;
  usage: Array<{
    provider: string;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number | null;
  }>;
}

/**
 * Builds the sanitized JSON trace of one run. Every value passes through
 * `sanitizeValue`, so a credential quoted in a tool result cannot leak.
 */
export function buildRunTraceExport(detail: RunDetail, now: Date): RunTraceExport {
  const { run } = detail;
  return {
    schemaVersion: 1,
    kind: "orqestra.run-trace",
    exportedAt: now.toISOString(),
    sanitized: true,
    run: {
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      retryOfRunId: run.retryOfRunId,
      input: sanitizeValue(run.input),
      output: sanitizeValue(run.output),
      error: sanitizeValue(run.error),
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      latencyMs: run.latencyMs,
      tokenUsage: sanitizeValue(run.tokenUsage),
      cost: run.cost,
      costKind: "estimated",
      metadata: sanitizeValue(run.metadata),
    },
    harness: {
      id: detail.harness.id,
      name: detail.harness.name,
      slug: detail.harness.slug,
      versionLabel: detail.harnessVersionLabel,
    },
    agent: detail.agent,
    steps: [...detail.steps]
      .sort((a, b) => a.index - b.index)
      .map((step) => ({
        index: step.index,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        nodeLabel: step.nodeLabel,
        status: step.status,
        iteration: step.iteration,
        startedAt: step.startedAt?.toISOString() ?? null,
        completedAt: step.completedAt?.toISOString() ?? null,
        durationMs: step.durationMs,
        input: sanitizeValue(step.input),
        output: sanitizeValue(step.output),
        error: sanitizeValue(step.error),
        metadata: sanitizeValue(step.metadata),
      })),
    events: detail.events.map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.at.toISOString(),
      payload: sanitizeValue(event.payload),
    })),
    usage: detail.usage.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      costUsd: entry.costUsd,
    })),
  };
}
