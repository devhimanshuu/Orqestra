/**
 * Per-run tool service — the only way a node reaches a tool.
 *
 *   permission check → budget check → TOOL_STARTED → registry.execute
 *     (retry on transient failures) → TOOL_COMPLETED / TOOL_FAILED
 *
 * Errors are normalized to `ToolExecutionError`; the registry's own errors
 * (unknown tool, invalid input) are permanent by definition, while an execution
 * failure inherits the retry classification of its cause (a fetch timeout is
 * worth one retry, a schema violation is not).
 */

import type { Logger } from "@/lib/logging/logger";
import type { ToolRegistry } from "@/modules/tools/tool.registry";
import { ToolError } from "@/modules/tools/tool.types";
import { CancelledError, RuntimeError, ToolExecutionError } from "../errors/runtime-error";
import type { RuntimeEventEmitter } from "../events/event-emitter";
import type { LimitTracker } from "../policies/limits";
import { classifyError, withRetry, type RetryPolicy, type RetryAttemptContext } from "../policies/retry";
import { assertToolAllowed, type ToolPermissionPolicy } from "./permissions";

export interface ToolCallRequest {
  toolId: string;
  input: unknown;
  nodeId: string;
}

export interface ToolCallResult {
  toolId: string;
  output: unknown;
  durationMs: number;
}

export interface RuntimeToolServiceOptions {
  registry: ToolRegistry;
  permissions: ToolPermissionPolicy;
  emitter: RuntimeEventEmitter;
  limits: LimitTracker;
  logger: Logger;
  signal: AbortSignal;
  retryPolicy?: RetryPolicy;
  callTimeoutMs?: number;
  onCallAccepted?: (toolId: string) => void;
}

export class RuntimeToolService {
  private readonly registry: ToolRegistry;
  private readonly permissions: ToolPermissionPolicy;
  private readonly emitter: RuntimeEventEmitter;
  private readonly limits: LimitTracker;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private readonly retryPolicy: RetryPolicy | undefined;
  private readonly callTimeoutMs: number;
  private readonly onCallAccepted: ((toolId: string) => void) | undefined;

  constructor(options: RuntimeToolServiceOptions) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.emitter = options.emitter;
    this.limits = options.limits;
    this.logger = options.logger;
    this.signal = options.signal;
    this.retryPolicy = options.retryPolicy;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.onCallAccepted = options.onCallAccepted;
  }

  /** Permission decisions are observable but do not throw (used by the UI). */
  wouldAllow(toolId: string): boolean {
    return assertToolAllowedSafe(this.permissions, toolId);
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    // 1. Governance first: a denied tool never touches the registry.
    assertToolAllowed(this.permissions, request.toolId, request.nodeId);

    if (!this.registry.has(request.toolId)) {
      const available = this.registry
        .list()
        .map((tool) => tool.id)
        .join(", ");
      throw new ToolExecutionError(
        `Tool "${request.toolId}" is not registered${available === "" ? "" : ` (available: ${available})`}`,
        { nodeId: request.nodeId, details: { toolId: request.toolId } },
      );
    }

    this.assertNotCancelled(request.nodeId);
    this.limits.assertWithinDeadline();
    this.limits.registerToolCall();
    this.onCallAccepted?.(request.toolId);

    this.emitter.emit({ type: "TOOL_STARTED", nodeId: request.nodeId, toolId: request.toolId });

    try {
      const result = await withRetry(
        async () => {
          this.assertNotCancelled(request.nodeId);
          const call = this.registry.execute(request.toolId, request.input, {
            logger: this.logger,
            signal: this.signal,
            metadata: { nodeId: request.nodeId },
          });
          return this.withTimeout(call, request);
        },
        {
          ...(this.retryPolicy !== undefined ? { policy: this.retryPolicy } : {}),
          signal: this.signal,
          onRetry: (context: RetryAttemptContext) => {
            this.logger.warn("tool call retrying", {
              toolId: request.toolId,
              nodeId: request.nodeId,
              attempt: context.attempt,
              classification: context.classification,
            });
          },
        },
      );

      this.emitter.emit({
        type: "TOOL_COMPLETED",
        nodeId: request.nodeId,
        toolId: request.toolId,
        durationMs: result.durationMs,
      });

      return { toolId: request.toolId, output: result.output, durationMs: result.durationMs };
    } catch (error) {
      const normalized = this.normalize(error, request);
      this.emitter.emit({
        type: "TOOL_FAILED",
        nodeId: request.nodeId,
        toolId: request.toolId,
        error: {
          code: normalized.code,
          message: normalized.message,
          nodeId: request.nodeId,
          retryable: normalized.retryable,
        },
      });
      throw normalized;
    }
  }

  private assertNotCancelled(nodeId: string): void {
    if (this.signal.aborted) {
      throw new CancelledError("Run cancelled while calling a tool", { nodeId });
    }
  }

  private withTimeout<T>(promise: Promise<T>, request: ToolCallRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ToolExecutionError(
            `Tool "${request.toolId}" timed out after ${Math.round(this.callTimeoutMs / 1000)}s`,
            {
              nodeId: request.nodeId,
              retryable: true,
              details: { toolId: request.toolId, timeoutMs: this.callTimeoutMs },
            },
          ),
        );
      }, this.callTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Maps tool/registry failures onto the runtime error model. */
  private normalize(error: unknown, request: ToolCallRequest): RuntimeError {
    if (error instanceof CancelledError || error instanceof ToolExecutionError) {
      return error;
    }
    if (error instanceof ToolError) {
      // Unknown tool / invalid input are permanent; execution failures inherit
      // the retry classification of the underlying cause.
      const retryable =
        error.code === "EXECUTION_FAILED" &&
        ["transient", "timeout", "rate_limit"].includes(classifyError(error.cause));
      return new ToolExecutionError(`Tool "${request.toolId}" failed: ${error.message}`, {
        nodeId: request.nodeId,
        retryable,
        details: { toolId: request.toolId, code: error.code },
        cause: error,
      });
    }
    return new ToolExecutionError(
      `Tool "${request.toolId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      { nodeId: request.nodeId, retryable: false, cause: error },
    );
  }
}

function assertToolAllowedSafe(policy: ToolPermissionPolicy, toolId: string): boolean {
  try {
    assertToolAllowed(policy, toolId, "(permission-probe)");
    return true;
  } catch {
    return false;
  }
}
