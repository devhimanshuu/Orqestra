/**
 * Structured runtime error model.
 *
 * Every failure the runtime can produce is one of these classes. They carry a
 * stable machine `code`, an optional node id, and a `retryable` hint — the
 * retry policy reads that hint instead of guessing from message text.
 *
 * What never leaves this module: stack traces, provider payloads, secrets.
 * `toRuntimeErrorPayload()` is the only thing that reaches the database, the
 * API, or the UI.
 */

export type RuntimeErrorCode =
  | "VALIDATION_ERROR"
  | "HARNESS_NOT_EXECUTABLE"
  | "NODE_EXECUTION_ERROR"
  | "TOOL_EXECUTION_ERROR"
  | "PERMISSION_DENIED"
  | "LLM_ERROR"
  | "TIMEOUT"
  | "MAX_ITERATIONS_EXCEEDED"
  | "LIMIT_EXCEEDED"
  | "CANCELLED"
  | "INVALID_STATE_TRANSITION"
  | "INTERNAL_ERROR";

/** Classification used by the retry policy (src/modules/runtime/policies/retry.ts). */
export type ErrorClass =
  | "transient"
  | "permanent"
  | "validation"
  | "permission"
  | "timeout"
  | "rate_limit";

/** Serializable error shape persisted on runs/steps and shown to users. */
export interface RuntimeErrorPayload {
  code: RuntimeErrorCode;
  message: string;
  nodeId?: string;
  retryable: boolean;
}

export interface RuntimeErrorOptions {
  nodeId?: string;
  retryable?: boolean;
  /** Provider/tool detail for logs — never persisted into the user-facing payload. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class RuntimeError extends Error {
  public readonly code: RuntimeErrorCode;
  public readonly nodeId: string | undefined;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: RuntimeErrorCode, message: string, options: RuntimeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.nodeId = options.nodeId;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  /** Classification consumed by the retry policy. */
  public errorClass(): ErrorClass {
    switch (this.code) {
      case "TIMEOUT":
        return "timeout";
      case "PERMISSION_DENIED":
        return "permission";
      case "VALIDATION_ERROR":
      case "HARNESS_NOT_EXECUTABLE":
      case "INVALID_STATE_TRANSITION":
        return "validation";
      case "MAX_ITERATIONS_EXCEEDED":
      case "LIMIT_EXCEEDED":
      case "CANCELLED":
        return "permanent";
      default:
        return this.retryable ? "transient" : "permanent";
    }
  }
}

/** Graph or configuration is wrong — retrying cannot help. */
export class ValidationError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("VALIDATION_ERROR", message, options);
    this.name = "ValidationError";
  }
}

/** The harness version cannot be executed by this runtime (unsupported node, …). */
export class HarnessNotExecutableError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("HARNESS_NOT_EXECUTABLE", message, options);
    this.name = "HarnessNotExecutableError";
  }
}

/** A node executor failed. */
export class NodeExecutionError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("NODE_EXECUTION_ERROR", message, options);
    this.name = "NodeExecutionError";
  }
}

/** A tool refused, rejected input, or crashed. */
export class ToolExecutionError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("TOOL_EXECUTION_ERROR", message, { retryable: false, ...options });
    this.name = "ToolExecutionError";
  }
}

/** The permission layer denied a tool call. */
export class PermissionError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("PERMISSION_DENIED", message, options);
    this.name = "PermissionError";
  }
}

/** Any LLM/provider failure. */
export class LlmRuntimeError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("LLM_ERROR", message, options);
    this.name = "LlmRuntimeError";
  }
}

/** The run exceeded its time budget. */
export class RuntimeTimeoutError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("TIMEOUT", message, options);
    this.name = "RuntimeTimeoutError";
  }
}

/** A loop ran longer than its configured maximum. */
export class MaxIterationsError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("MAX_ITERATIONS_EXCEEDED", message, options);
    this.name = "MaxIterationsError";
  }
}

/** A run-level budget (nodes, LLM calls, tool calls, cost) was exhausted. */
export class LimitExceededError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("LIMIT_EXCEEDED", message, options);
    this.name = "LimitExceededError";
  }
}

/** Cancellation observed from the caller's signal or the cancellation channel. */
export class CancelledError extends RuntimeError {
  constructor(message = "Run cancelled", options: RuntimeErrorOptions = {}) {
    super("CANCELLED", message, options);
    this.name = "CancelledError";
  }
}

/** Guarded state machine violation — a programming error, not user error. */
export class InvalidStateTransitionError extends RuntimeError {
  constructor(from: string, to: string, options: RuntimeErrorOptions = {}) {
    super("INVALID_STATE_TRANSITION", `Cannot move execution from "${from}" to "${to}"`, options);
    this.name = "InvalidStateTransitionError";
  }
}

/** Anything unexpected. Never surfaces internals to users. */
export class InternalRuntimeError extends RuntimeError {
  constructor(message: string, options: RuntimeErrorOptions = {}) {
    super("INTERNAL_ERROR", message, options);
    this.name = "InternalRuntimeError";
  }
}

const USER_SAFE_MESSAGES: Partial<Record<RuntimeErrorCode, string>> = {
  INTERNAL_ERROR: "The run failed unexpectedly. Check the server logs for details.",
  LLM_ERROR: "The model provider call failed.",
  TIMEOUT: "The run exceeded its time limit.",
  CANCELLED: "The run was cancelled.",
  MAX_ITERATIONS_EXCEEDED: "The harness kept looping past its configured maximum iterations.",
  LIMIT_EXCEEDED: "The run exceeded an execution budget.",
  PERMISSION_DENIED: "A tool call was denied by the run's permissions.",
};

/**
 * Reduces any thrown value to the persisted/streamed payload.
 *
 * Unknown errors become INTERNAL_ERROR with a generic message — internal stack
 * traces and driver errors are logged by the caller, never returned.
 */
export function toRuntimeErrorPayload(error: unknown, nodeId?: string): RuntimeErrorPayload {
  if (error instanceof RuntimeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.nodeId !== undefined ? { nodeId: error.nodeId } : nodeId !== undefined ? { nodeId } : {}),
      retryable: error.retryable,
    };
  }

  const safe = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL_ERROR",
    message: USER_SAFE_MESSAGES.INTERNAL_ERROR ?? safe,
    ...(nodeId !== undefined ? { nodeId } : {}),
    retryable: false,
  };
}

/** i18n-free human text for a code (used when a payload has no message). */
export function describeRuntimeErrorCode(code: RuntimeErrorCode): string {
  return USER_SAFE_MESSAGES[code] ?? "The run failed.";
}
