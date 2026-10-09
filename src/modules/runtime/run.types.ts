import type { RuntimeEvent } from "./events/events";
import type { RuntimeErrorPayload } from "./errors/runtime-error";
import type { RuntimeExecutionLimits } from "./state/execution-state";
import type { UsageEntry, UsageTotal } from "./usage/tracker";

/**
 * Run & Trace domain model (Phase 2).
 *
 *   Run ─┬─ RunStep[]        ordered node executions (with trace documents)
 *        ├─ RuntimeEvent[]   full event stream (timeline, SSE replay, analytics)
 *        └─ UsageRecord[]    per provider/model token + cost aggregates
 *
 * Every run pins harnessVersionId + agent/agentVersion + a `metadata` snapshot
 * (engine version, content hash, limits, provider refs), so a stored run can be
 * explained, compared and retried years later without guessing.
 *
 * Immutability: historical runs are never mutated. Retrying creates a new run
 * that points back at its predecessor (`retryOfRunId`).
 */

export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STEP_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"] as const;
export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Reproducibility snapshot stored on every run (immutable after start). */
export interface RunMetadata {
  /** Runtime engine version that executed (or will execute) the run. */
  engineVersion: string;
  /** SHA-256 of the harness definition the run is pinned to. */
  harnessContentHash: string | null;
  harnessVersion: number | null;
  nodeCount: number;
  edgeCount: number;
  nodeTypes: string[];
  model: string | null;
  provider: string | null;
  limits: RuntimeExecutionLimits;
  /** Tool ids the run may call (empty = no allowlist). */
  allowedTools: string[];
  executionMode: "queue" | "inline" | "unknown";
  [key: string]: unknown;
}

export interface RuntimeUsageRecord {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface Run {
  id: string;
  harnessId: string;
  harnessVersionId: string;
  agentId: string | null;
  agentVersion: number | null;
  status: RunStatus;
  input: unknown;
  output: unknown | null;
  tokenUsage: TokenUsage | null;
  cost: number | null;
  latencyMs: number | null;
  error: RuntimeErrorPayload | null;
  metadata: RunMetadata | null;
  attempt: number;
  retryOfRunId: string | null;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface RunStep {
  id: string;
  runId: string;
  index: number;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  status: RunStepStatus;
  input: unknown | null;
  output: unknown | null;
  error: RuntimeErrorPayload | null;
  metadata: Record<string, unknown> | null;
  iteration: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface PersistedRuntimeEvent {
  seq: number;
  type: string;
  payload: RuntimeEvent;
  at: Date;
}

/** Everything the run detail page needs, in one payload. */
export interface RunDetail {
  run: Run;
  steps: RunStep[];
  events: PersistedRuntimeEvent[];
  usage: RuntimeUsageRecord[];
  usageTotal: UsageTotal;
  harness: { id: string; name: string; slug: string };
  harnessVersionLabel: number | null;
  agent: { id: string; name: string } | null;
  /** True while the run can still be cancelled / still emits live events. */
  live: boolean;
}

/** Compact row for the runs table. */
export interface RunListItem {
  id: string;
  status: RunStatus;
  harnessId: string;
  harnessName: string;
  harnessVersionLabel: number | null;
  agentId: string | null;
  agentName: string | null;
  attempt: number;
  retryOfRunId: string | null;
  inputPreview: string;
  outputPreview: string | null;
  errorCode: string | null;
  totalTokens: number;
  cost: number | null;
  costKnown: boolean;
  durationMs: number | null;
  stepCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RunListFilters {
  agentId?: string;
  harnessId?: string;
  projectId?: string;
  status?: RunStatus | RunStatus[];
  /** Inclusive lower bound on createdAt. */
  since?: Date;
  /** Inclusive upper bound on createdAt. */
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface RunListPage {
  runs: RunListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateRunInput {
  agentId: string;
  harnessVersionId: string;
  input: string;
  /** Optional overrides, clamped to platform ceilings by the service. */
  limits?: Partial<RuntimeExecutionLimits>;
}

export interface RunWithSteps extends Run {
  steps: RunStep[];
  usage: RuntimeUsageRecord[];
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" not found`);
    this.name = "RunNotFoundError";
  }
}

export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

export type { UsageEntry, UsageTotal };
