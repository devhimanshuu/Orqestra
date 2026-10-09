/**
 * Retry policy.
 *
 * Not every failure deserves a retry. Errors are classified first:
 *
 *   transient   network blips, 5xx, socket resets        → retry
 *   rate_limit  429                                      → retry (longer backoff)
 *   timeout     provider deadline                        → retry
 *   validation  bad config, unparseable model output     → no retry
 *   permission  tool denied for this run                 → no retry
 *   permanent   everything else                          → no retry
 *
 * Backoff is exponential with optional jitter, and the sleep is abortable and
 * injectable so tests stay deterministic and a cancelled run does not wait out
 * a timer.
 */

import { LLMProviderError } from "@/modules/llm/llm.types";
import {
  LlmRuntimeError,
  RuntimeError,
  RuntimeTimeoutError,
  ToolExecutionError,
  type ErrorClass,
} from "../errors/runtime-error";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Adds up to 25% random jitter so parallel runs do not synchronise. */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitter: true,
};

export const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false };

/** Maps provider error codes onto the retry-relevant classes. */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof RuntimeError) {
    return error.errorClass();
  }
  // Provider errors are classified by their own code, before message sniffing:
  // a 429 must always be retryable no matter how the provider words it.
  if (error instanceof LLMProviderError) {
    switch (error.code) {
      case "rate_limited":
        return "rate_limit";
      case "timeout":
        return "timeout";
      case "provider_error":
        return error.retryable ? "transient" : "permanent";
      default:
        return "permanent";
    }
  }
  if (error instanceof ToolExecutionError || error instanceof LlmRuntimeError) {
    return error.retryable ? "transient" : "permanent";
  }
  if (error instanceof RuntimeTimeoutError) {
    return "timeout";
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("rate limit") || message.includes("429")) {
      return "rate_limit";
    }
    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("econnreset") ||
      message.includes("socket hang up")
    ) {
      return "timeout";
    }
    if (
      error.name === "AbortError" ||
      message.includes("fetch failed") ||
      message.includes("econnrefused") ||
      message.includes("network")
    ) {
      return "transient";
    }
  }
  return "permanent";
}

export function isRetryable(error: unknown): boolean {
  const classification = classifyError(error);
  return classification === "transient" || classification === "rate_limit" || classification === "timeout";
}

export interface RetryAttemptContext {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
  classification: ErrorClass;
}

export interface WithRetryOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (context: RetryAttemptContext) => void | Promise<void>;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export class RetryAbortedError extends Error {
  constructor(cause: unknown) {
    super("Retry aborted by cancellation", { cause });
    this.name = "RetryAbortedError";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RetryAbortedError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new RetryAbortedError(signal?.reason));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delayFor(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (!policy.jitter) {
    return capped;
  }
  return Math.round(capped * (0.75 + random() * 0.25));
}

/**
 * Runs `operation` with retries. `attempt` starts at 1; the operation receives
 * it so it can adjust (e.g. ask the model to repair its JSON on attempt 2).
 * Throws the last error when retries are exhausted or the error is not
 * retryable.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, policy.maxRetries + 1);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const classification = classifyError(error);
      const canRetry = attempt < maxAttempts && isRetryable(error);
      if (!canRetry) {
        throw error;
      }
      const delayMs = delayFor(attempt, policy, random);
      await options.onRetry?.({ attempt, maxAttempts, delayMs, error, classification });
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
