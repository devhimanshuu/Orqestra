import type { RuntimeEvent, RuntimeError } from "./execution.types";

/**
 * Run & Trace domain model.
 *
 * Designed up-front (Phase 0) so the Phase 3 observability UI needs no schema
 * redesign:
 *
 *   Run ─┬─ RunStep 0  (Planner)   ── Trace (ordered RuntimeEvents)
 *        ├─ RunStep 1  (Search)
 *        ├─ RunStep 2  (Search)
 *        ├─ RunStep 3  (Critic)
 *        ├─ RunStep 4  (Verifier)
 *        └─ RunStep 5  (Final)
 *
 * Every run pins harnessId + harnessVersionId (+ agent/agentVersion when the
 * run came from an agent), so results stay reproducible and comparable across
 * harness versions — the basis for A/B tests and experiments.
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

export interface Run {
  id: string;
  harnessId: string;
  harnessVersionId: string;
  /** Null for harness-only runs in Phase 0; set once agent-driven runs land. */
  agentId: string | null;
  agentVersion: number | null;
  status: RunStatus;
  input: unknown;
  output: unknown | null;
  tokenUsage: TokenUsage | null;
  cost: number | null;
  latencyMs: number | null;
  error: RuntimeError | null;
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
  error: RuntimeError | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface TraceDocument {
  id: string;
  runStepId: string;
  events: RuntimeEvent[];
  createdAt: Date;
}

export interface CreateRunInput {
  harnessVersionId: string;
  input: unknown;
  agentId?: string;
  agentVersion?: number;
}

export interface RunWithSteps extends Run {
  steps: RunStep[];
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" not found`);
    this.name = "RunNotFoundError";
  }
}
