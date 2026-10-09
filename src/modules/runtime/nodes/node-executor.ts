/**
 * Node executor contract.
 *
 * One executor per `HarnessNodeType`. An executor is a pure-ish function of
 * (config, flow input, run state, services) → result: it never touches the
 * database, HTTP, or the clock directly (the injected `services` own all of
 * that), and it never mutates run state in place — it *returns a state patch*.
 * That is what keeps execution deterministic and replayable.
 *
 *   Runtime engine ──> NodeExecutorRegistry.get(type) ──> executor.execute(ctx, config)
 *
 * Configs arrive as `Record<string, unknown>` (they were Zod-validated by the
 * harness validator at publish time); executors read fields through the
 * `readString`/`readNumber`/… helpers so a malformed config fails as a
 * structured ValidationError instead of a `undefined` surprise mid-run.
 */

import type { HarnessNodeType } from "@/modules/harness/harness.schema";
import type { Logger } from "@/lib/logging/logger";
import { ValidationError } from "../errors/runtime-error";
import type { ExpressionScope } from "../context/expression";
import type { ExecutionState } from "../state/execution-state";
import type { RuntimeTokenUsage } from "../usage/tracker";
import type { RuntimeLlmService } from "../services/llm-service";
import type { RuntimeToolService } from "../services/tool-service";
import type { RunMemoryStore } from "../services/memory";
import type { LimitTracker } from "../policies/limits";

/** A node as the runtime sees it after compilation. */
export interface RuntimeNode {
  id: string;
  type: HarnessNodeType;
  label: string;
  description?: string;
  config: Record<string, unknown>;
}

/** Agent configuration pinned to the run (null for harness-only runs). */
export interface RuntimeAgentContext {
  id: string | null;
  version: number | null;
  instructions: string | null;
  /** "provider:model" the agent defaults to; model nodes may override. */
  model: string | null;
  /** Tool ids the agent may use. Empty = no allowlist (harness decides). */
  capabilities: string[];
}

/** Per-run services. Created once per run, shared by every node execution. */
export interface RuntimeNodeServices {
  llm: RuntimeLlmService;
  tools: RuntimeToolService;
  limits: LimitTracker;
  memory: RunMemoryStore;
  agent: RuntimeAgentContext | null;
  logger: Logger;
  signal: AbortSignal;
  now: () => Date;
  /** Shared run state — read-only for executors (write via the result patch). */
  state: Readonly<ExecutionState>;
}

export interface RuntimeOutgoingEdge {
  edgeId: string;
  target: string;
  /** Optional edge label from the DSL — routers may match on it. */
  label: string | null;
}

export interface NodeExecutionContext {
  /** Run identity, for provider metadata and trace labelling. */
  run: {
    id: string;
    harnessId: string;
    harnessVersionId: string;
    iteration: number;
  };
  node: RuntimeNode;
  /** Value flowing into this node: previous node's output (or the run input). */
  input: unknown;
  /** Edges leaving this node, in declaration order (graph-aware nodes read this). */
  outgoing: RuntimeOutgoingEdge[];
  /** Resolved data view for `{{ … }}` templates. */
  scope: ExpressionScope;
  services: RuntimeNodeServices;
}

export interface NodeExecutionResult {
  /** What downstream nodes (and `{{ previous.output }}`) receive. */
  output: unknown;
  /** Patch merged into run state (`state.*`). Shallow merge, explicit keys. */
  state?: Record<string, unknown>;
  /** Branch handle to follow: condition `true`/`false`, loop `body`/`exit`. */
  branch?: string;
  /** Explicit next node (router). Bypasses the edge lookup, still validated. */
  nextNodeId?: string;
  /** Token usage produced by this node (aggregated by the engine). */
  usage?: RuntimeTokenUsage;
  /** Node-specific trace metadata (condition explanation, tool id, plan size…). */
  metadata?: Record<string, unknown>;
  /** Non-fatal notes surfaced in the run UI. */
  warnings?: string[];
}

export interface NodeExecutor<TConfig = Record<string, unknown>> {
  readonly type: HarnessNodeType;
  /** Throws ValidationError when the stored config cannot execute. */
  validate(config: Record<string, unknown>, node: RuntimeNode): void;
  execute(context: NodeExecutionContext, config: TConfig): Promise<NodeExecutionResult>;
}

// --- config readers ---------------------------------------------------------

function configError(node: RuntimeNode, message: string): ValidationError {
  return new ValidationError(`Node "${node.label}" (${node.type}): ${message}`, {
    nodeId: node.id,
  });
}

export function readString(
  config: Record<string, unknown>,
  key: string,
  node: RuntimeNode,
  options: { required?: boolean } = {},
): string | undefined {
  const value = config[key];
  if (value === undefined || value === null) {
    if (options.required === true) {
      throw configError(node, `missing required config field "${key}"`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw configError(node, `config field "${key}" must be a string`);
  }
  if (options.required === true && value.trim() === "") {
    throw configError(node, `config field "${key}" must not be empty`);
  }
  return value;
}

export function readNumber(
  config: Record<string, unknown>,
  key: string,
  node: RuntimeNode,
  options: { required?: boolean; min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const value = config[key];
  if (value === undefined || value === null) {
    if (options.required === true) {
      throw configError(node, `missing required config field "${key}"`);
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw configError(node, `config field "${key}" must be a number`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw configError(node, `config field "${key}" must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw configError(node, `config field "${key}" must be ≥ ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw configError(node, `config field "${key}" must be ≤ ${options.max}`);
  }
  return value;
}

export function readRecord(
  config: Record<string, unknown>,
  key: string,
  node: RuntimeNode,
): Record<string, unknown> | undefined {
  const value = config[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError(node, `config field "${key}" must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readEnum<T extends string>(
  config: Record<string, unknown>,
  key: string,
  node: RuntimeNode,
  allowed: readonly T[],
  options: { required?: boolean } = {},
): T | undefined {
  const value = readString(config, key, node, options);
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw configError(node, `config field "${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// --- shared output helpers --------------------------------------------------

/** Node reference used in expressions: node id first, then label slug. */
export function toReferenceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Renders arbitrary input as LLM-ready text. */
export function inputToText(input: unknown): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return String(input);
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    // Prompt-model chains pass `{ text }`; unwrap it so the model sees the
    // prompt itself instead of JSON-wrapped prompt text.
    if (typeof record["text"] === "string" && Object.keys(record).length >= 1) {
      return record["text"];
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** True for `{}`-shaped values (used when a tool/LLM result is spread outward). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
