/**
 * Execution state machine.
 *
 * The runtime keeps exactly one `ExecutionState` per run. Status changes go
 * through `transitionExecutionState()`, which validates the move against an
 * explicit table and throws `InvalidStateTransitionError` otherwise — there is
 * no way to "set" a status directly, so a buggy executor cannot resurrect a
 * finished run.
 *
 * Runtime statuses (spec) map onto the persisted `RunStatus` enum:
 *
 *   queued → QUEUED      waiting → RUNNING     completed → SUCCEEDED
 *   running → RUNNING    paused → RUNNING      failed → FAILED
 *                                              cancelled → CANCELLED
 *                                              timeout → TIMED_OUT
 */

import { InvalidStateTransitionError } from "../errors/runtime-error";
import type { HarnessNodeType } from "@/modules/harness/harness.schema";
import type { RuntimeErrorPayload } from "../errors/runtime-error";

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type PersistedRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

/** Legal status moves. Terminal states have no outgoing edges. */
const ALLOWED_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["running", "waiting", "paused", "completed", "failed", "cancelled", "timeout"],
  waiting: ["running", "paused", "cancelled", "failed", "timeout"],
  paused: ["running", "cancelled", "failed", "timeout"],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: [],
};

export const PERSISTED_STATUS_BY_EXECUTION_STATUS: Record<ExecutionStatus, PersistedRunStatus> = {
  queued: "QUEUED",
  running: "RUNNING",
  waiting: "RUNNING",
  paused: "RUNNING",
  completed: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timeout: "TIMED_OUT",
};

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/** One executed node. Persisted as a RunStep row. */
export interface ExecutionStep {
  nodeId: string;
  nodeType: HarnessNodeType;
  nodeLabel: string;
  status: StepStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: RuntimeErrorPayload | null;
  /** Executor specifics (iterations, tool ids, LLM metadata, conditions…). */
  metadata: Record<string, unknown>;
}

/** Per-run budgets and pins — persisted on the run for reproducibility. */
export interface ExecutionMetadata {
  agentId: string | null;
  agentVersion: number | null;
  harnessId: string;
  harnessVersionId: string;
  nodeCount: number;
  edgeCount: number;
  limits: RuntimeExecutionLimits;
  /** Declared node types, so a stored run documents what it executed. */
  nodeTypes: HarnessNodeType[];
  startedAt: Date;
  deadlineAt: Date;
}

export interface RuntimeExecutionLimits {
  maxDurationMs: number;
  maxNodes: number;
  maxIterations: number;
  maxToolCalls: number;
  maxLlmCalls: number;
  /** Optional cost ceiling in USD; null means "no cost limit". */
  maxCostUsd: number | null;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeExecutionLimits = {
  maxDurationMs: 120_000,
  maxNodes: 100,
  maxIterations: 10,
  maxToolCalls: 20,
  maxLlmCalls: 30,
  maxCostUsd: null,
};

export interface ExecutionState {
  runId: string;
  harnessId: string;
  harnessVersionId: string;
  agentId: string | null;
  status: ExecutionStatus;
  input: unknown;
  output: unknown | null;
  currentNodeId: string | null;
  /** Shared run state — the `state`/`variables` root of expressions. */
  variables: Record<string, unknown>;
  history: ExecutionStep[];
  metadata: ExecutionMetadata;
  error: RuntimeErrorPayload | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateExecutionStateInput {
  runId: string;
  harnessId: string;
  harnessVersionId: string;
  agentId: string | null;
  agentVersion: number | null;
  input: unknown;
  nodeCount: number;
  edgeCount: number;
  nodeTypes: HarnessNodeType[];
  limits?: Partial<RuntimeExecutionLimits>;
  startedAt: Date;
}

export function createExecutionState(input: CreateExecutionStateInput): ExecutionState {
  const limits: RuntimeExecutionLimits = { ...DEFAULT_RUNTIME_LIMITS, ...input.limits };
  return {
    runId: input.runId,
    harnessId: input.harnessId,
    harnessVersionId: input.harnessVersionId,
    agentId: input.agentId,
    status: "queued",
    input: input.input,
    output: null,
    currentNodeId: null,
    variables: {},
    history: [],
    metadata: {
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      harnessId: input.harnessId,
      harnessVersionId: input.harnessVersionId,
      nodeCount: input.nodeCount,
      edgeCount: input.edgeCount,
      limits,
      nodeTypes: input.nodeTypes,
      startedAt: input.startedAt,
      deadlineAt: new Date(input.startedAt.getTime() + limits.maxDurationMs),
    },
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

/** Applies a status change, rejecting illegal moves. */
export function transitionExecutionState(
  state: ExecutionState,
  next: ExecutionStatus,
): ExecutionState {
  if (next === state.status) {
    return state;
  }
  if (!ALLOWED_TRANSITIONS[state.status].includes(next)) {
    throw new InvalidStateTransitionError(state.status, next, {
      details: { runId: state.runId, nodeId: state.currentNodeId ?? undefined },
    });
  }
  return { ...state, status: next };
}

/** Marks the run as terminal. Terminal states accept no further transitions. */
export function finishExecutionState(
  state: ExecutionState,
  status: Extract<ExecutionStatus, "completed" | "failed" | "cancelled" | "timeout">,
  options: { output?: unknown; error?: RuntimeErrorPayload | null; at: Date },
): ExecutionState {
  const transitioned = transitionExecutionState(state, status);
  return {
    ...transitioned,
    currentNodeId: null,
    output: options.output === undefined ? transitioned.output : options.output,
    error: options.error ?? null,
    completedAt: options.at,
  };
}

export function appendStep(state: ExecutionState, step: ExecutionStep): void {
  state.history.push(step);
}
