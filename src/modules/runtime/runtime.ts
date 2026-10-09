/**
 * Orqestra Runtime — public entry point.
 *
 * Everything outside `src/modules/runtime` talks to the runtime through this
 * module (plus the persistence helpers in `run.executor.ts`). It is deliberately
 * framework-free: no Next.js, no React, no Prisma, no Redis. A CLI, a worker, a
 * test harness, or a future hosted executor all call the same function.
 *
 *   definition → compileHarness() → ExecutionPlan → executeHarness() → outcome
 *
 * Consumers:
 *   - worker.ts / run.executor.ts  (async execution)
 *   - scripts + tests              (inline execution)
 *   - API routes                   (preview, never execution)
 */

export { compileHarness, previewHarnessCompilation } from "./compiler";
export type {
  CompileResult,
  CompileWarning,
  CompiledEdge,
  CompiledNode,
  ExecutionPlan,
  ExecutionPreview,
  PlanStats,
  PreviewCheck,
} from "./compiler";

export { executeHarness } from "./executor/engine";
export type { ExecuteHarnessOptions, ExecuteHarnessOutcome } from "./executor/engine";

export { buildExpressionScope } from "./executor/scope";
export { evaluateCondition } from "./context/condition";
export { resolvePath, resolveTemplate, resolveValue, resolveText } from "./context/expression";
export type { ConditionEvaluation } from "./context/condition";
export type { ExpressionScope } from "./context/expression";

export { getNodeExecutorRegistry, createNodeExecutorRegistry, NodeExecutorRegistry } from "./nodes/registry";
export { nodeUnsupportedReason, EXECUTABLE_NODE_TYPES } from "./nodes/executability";
export type {
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  RuntimeAgentContext,
  RuntimeNode,
  RuntimeNodeServices,
} from "./nodes/node-executor";

export { createRuntimeServices } from "./services/runtime-services";
export { ALLOW_ALL_TOOLS, allowlistFromCapabilities, decideToolPermission } from "./services/permissions";
export type { ToolPermissionPolicy, PermissionDecision } from "./services/permissions";
export { RunMemoryStore } from "./services/memory";

export {
  DEFAULT_RUNTIME_LIMITS,
  PERSISTED_STATUS_BY_EXECUTION_STATUS,
  createExecutionState,
  isTerminalStatus,
  transitionExecutionState,
} from "./state/execution-state";
export type {
  ExecutionMetadata,
  ExecutionState,
  ExecutionStatus,
  ExecutionStep,
  PersistedRunStatus,
  RuntimeExecutionLimits,
  StepStatus,
} from "./state/execution-state";

export { RuntimeEventEmitter } from "./events/event-emitter";
export type { RuntimeEventSink } from "./events/event-emitter";
export type { RuntimeEvent, RuntimeEventDraft, RuntimeEventType } from "./events/events";

export { LimitTracker } from "./policies/limits";
export { DEFAULT_RETRY_POLICY, NO_RETRY, classifyError, isRetryable, withRetry } from "./policies/retry";
export type { RetryPolicy } from "./policies/retry";

export { UsageTracker, estimateCostUsd, MODEL_PRICE_TABLE } from "./usage/tracker";
export type { RuntimeTokenUsage, UsageEntry, UsageTotal } from "./usage/tracker";

export {
  CancelledError,
  HarnessNotExecutableError,
  InvalidStateTransitionError,
  LlmRuntimeError,
  LimitExceededError,
  MaxIterationsError,
  NodeExecutionError,
  PermissionError,
  RuntimeError,
  RuntimeTimeoutError,
  ToolExecutionError,
  ValidationError,
  describeRuntimeErrorCode,
  toRuntimeErrorPayload,
} from "./errors/runtime-error";
export type { ErrorClass, RuntimeErrorCode, RuntimeErrorPayload } from "./errors/runtime-error";

/** Provenance string persisted with every run (see run.executor.ts). */
export const RUNTIME_ENGINE_VERSION = "orqestra-runtime/0.2.0";
