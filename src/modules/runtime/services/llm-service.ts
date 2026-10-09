/**
 * Per-run LLM service — the only way a node reaches a model.
 *
 * Wraps the provider-agnostic `LLMGateway` (Phase 0) with everything a run
 * needs and nothing a provider should know about:
 *
 *   budget check → LLM_STARTED → gateway.generate (retry, timeout) →
 *   usage accounting → cost tracking → LLM_COMPLETED / LLM_FAILED
 *
 * Failures are normalized into `LlmRuntimeError` with provider error codes
 * mapped onto the retry classes, so a 429 is retried while a malformed request
 * fails immediately. Cancellation is observed via the run's AbortSignal and
 * surfaces as `CancelledError` — never as a provider error.
 */

import type { Logger } from "@/lib/logging/logger";
import { LLMProviderError, parseModelRef, type LLMMessage, type LLMResponse } from "@/modules/llm/llm.types";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import { CancelledError, LlmRuntimeError, RuntimeError, ValidationError } from "../errors/runtime-error";
import type { RuntimeEventEmitter } from "../events/event-emitter";
import type { LimitTracker } from "../policies/limits";
import { withRetry, type RetryPolicy } from "../policies/retry";
import { estimateCostUsd, type UsageTracker } from "../usage/tracker";

export interface LlmCallRequest {
  /** "provider:model", resolved by the gateway. */
  ref: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  stop?: string[];
  nodeId: string;
  /** Trace label: "model", "planner", "critic", "evaluator". */
  role: string;
}

export interface RuntimeLlmServiceOptions {
  gateway: LLMGateway;
  emitter: RuntimeEventEmitter;
  limits: LimitTracker;
  usage: UsageTracker;
  logger: Logger;
  signal: AbortSignal;
  retryPolicy?: RetryPolicy;
  /** Per-call ceiling; a hung provider must not hold the run forever. */
  callTimeoutMs?: number;
  onCost?: (costUsd: number | null) => void;
}

export class RuntimeLlmService {
  private readonly gateway: LLMGateway;
  private readonly emitter: RuntimeEventEmitter;
  private readonly limits: LimitTracker;
  private readonly usage: UsageTracker;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private readonly retryPolicy: RetryPolicy | undefined;
  private readonly callTimeoutMs: number;
  private readonly onCost: ((costUsd: number | null) => void) | undefined;

  constructor(options: RuntimeLlmServiceOptions) {
    this.gateway = options.gateway;
    this.emitter = options.emitter;
    this.limits = options.limits;
    this.usage = options.usage;
    this.logger = options.logger;
    this.signal = options.signal;
    this.retryPolicy = options.retryPolicy;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.onCost = options.onCost;
  }

  async generate(request: LlmCallRequest): Promise<LLMResponse> {
    const parsed = parseModelRef(request.ref);
    if (parsed === null) {
      throw new ValidationError(
        `"${request.ref}" is not a provider:model reference (expected e.g. gemini:gemini-2.0-flash)`,
        { nodeId: request.nodeId },
      );
    }

    this.assertNotCancelled(request.nodeId);
    this.limits.assertWithinDeadline();
    this.limits.registerLlmCall();

    this.emitter.emit({
      type: "LLM_STARTED",
      nodeId: request.nodeId,
      provider: parsed.provider,
      model: parsed.model,
    });

    try {
      const response = await withRetry(
        async (attempt) => {
          this.assertNotCancelled(request.nodeId);
          const call = this.gateway.generate(parsed, {
            messages: request.messages,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
            ...(request.responseFormat !== undefined ? { responseFormat: request.responseFormat } : {}),
            ...(request.stop !== undefined ? { stop: request.stop } : {}),
            metadata: { nodeId: request.nodeId, role: request.role, attempt },
          });
          return this.withTimeout(call, request.nodeId, attempt);
        },
        {
          ...(this.retryPolicy !== undefined ? { policy: this.retryPolicy } : {}),
          signal: this.signal,
          onRetry: ({ attempt, delayMs, classification }) => {
            this.logger.warn("llm call retrying", {
              nodeId: request.nodeId,
              attempt,
              delayMs,
              classification,
              provider: parsed.provider,
              model: parsed.model,
            });
          },
        },
      );

      this.usage.record({
        provider: response.provider,
        model: response.model,
        usage: response.usage,
      });
      const cost = estimateCostUsd(response.provider, response.model, response.usage);
      this.limits.registerCost(cost);
      this.onCost?.(cost);

      this.emitter.emit({
        type: "LLM_COMPLETED",
        nodeId: request.nodeId,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      return response;
    } catch (error) {
      const normalized = this.normalize(error, request.nodeId);
      this.emitter.emit({
        type: "LLM_FAILED",
        nodeId: request.nodeId,
        provider: parsed.provider,
        model: parsed.model,
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
      throw new CancelledError("Run cancelled while calling the model", { nodeId });
    }
  }

  private withTimeout<T>(promise: Promise<T>, nodeId: string, attempt: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new LlmRuntimeError(
            `Model call timed out after ${Math.round(this.callTimeoutMs / 1000)}s`,
            { nodeId, retryable: true, details: { attempt, timeoutMs: this.callTimeoutMs } },
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

  /** Maps provider/SDK failures onto the runtime error model. */
  private normalize(error: unknown, nodeId: string): RuntimeError {
    if (error instanceof CancelledError || error instanceof LlmRuntimeError) {
      return error;
    }
    if (error instanceof LLMProviderError) {
      const retryable =
        error.retryable || error.code === "rate_limited" || error.code === "timeout";
      return new LlmRuntimeError(`Model provider error (${error.code}): ${error.message}`, {
        nodeId,
        retryable,
        details: { provider: error.provider, code: error.code },
        cause: error,
      });
    }
    return new LlmRuntimeError(
      `Model call failed: ${error instanceof Error ? error.message : String(error)}`,
      { nodeId, retryable: true, cause: error },
    );
  }
}
