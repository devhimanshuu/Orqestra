import { describe, expect, it, vi } from "vitest";
import { LLMProviderError } from "@/modules/llm/llm.types";
import {
  InvalidStateTransitionError,
  LimitExceededError,
  MaxIterationsError,
  PermissionError,
  RuntimeTimeoutError,
  ToolExecutionError,
  ValidationError,
} from "../errors/runtime-error";
import {
  DEFAULT_RETRY_POLICY,
  NO_RETRY,
  classifyError,
  isRetryable,
  withRetry,
} from "./retry";
import { LimitTracker } from "./limits";
import {
  DEFAULT_RUNTIME_LIMITS,
  createExecutionState,
  finishExecutionState,
  isTerminalStatus,
  transitionExecutionState,
} from "../state/execution-state";

describe("retry classification", () => {
  it("classifies structured runtime errors", () => {
    expect(classifyError(new ValidationError("bad config"))).toBe("validation");
    expect(classifyError(new PermissionError("denied"))).toBe("permission");
    expect(classifyError(new RuntimeTimeoutError("slow"))).toBe("timeout");
    expect(classifyError(new ToolExecutionError("boom", { retryable: true }))).toBe("transient");
    expect(classifyError(new ToolExecutionError("boom"))).toBe("permanent");
    expect(classifyError(new MaxIterationsError("too many"))).toBe("permanent");
  });

  it("classifies provider errors by code, not message", () => {
    expect(classifyError(new LLMProviderError("rate_limited", "gemini", "slow down"))).toBe(
      "rate_limit",
    );
    expect(classifyError(new LLMProviderError("timeout", "gemini", "took too long"))).toBe("timeout");
    expect(
      classifyError(new LLMProviderError("provider_error", "gemini", "socket closed", { retryable: true })),
    ).toBe("transient");
    expect(classifyError(new LLMProviderError("invalid_response", "gemini", "junk"))).toBe(
      "permanent",
    );
  });

  it("classifies plain errors heuristically", () => {
    expect(classifyError(new Error("socket hang up"))).toBe("timeout");
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("transient");
    expect(classifyError(new Error("unexpected"))).toBe("permanent");
    expect(isRetryable(new Error("429 Too Many Requests"))).toBe(true);
  });
});

describe("withRetry", () => {
  const sleep = (): Promise<void> => Promise.resolve();

  it("returns the first successful result without sleeping", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    await expect(withRetry(operation, { sleep, onRetry })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries transient failures up to maxRetries and passes the attempt number", async () => {
    const attempts: number[] = [];
    const result = await withRetry<string>(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) {
          throw new LLMProviderError("rate_limited", "gemini", "slow down");
        }
        return "recovered";
      },
      { sleep },
    );

    expect(result).toBe("recovered");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("does not retry permanent failures", async () => {
    const operation = vi.fn().mockRejectedValue(new ValidationError("bad harness"));
    await expect(withRetry(operation, { sleep })).rejects.toThrow(ValidationError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("honors NO_RETRY", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new LLMProviderError("timeout", "ollama", "timeout"));
    await expect(withRetry(operation, { policy: NO_RETRY, sleep })).rejects.toThrow(LLMProviderError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially, reducing each delay by up to 25% as jitter", async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new ToolExecutionError("flaky", { retryable: true });
        },
        {
          policy: { ...DEFAULT_RETRY_POLICY, maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000, jitter: true },
          random: () => 1,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow(ToolExecutionError);
    // random() === 1 is the top of the jitter band, i.e. no reduction.
    expect(delays).toEqual([100, 200]);
  });
});

describe("LimitTracker", () => {
  const tracker = (overrides: Partial<typeof DEFAULT_RUNTIME_LIMITS> = {}, nowMs = 0): LimitTracker =>
    new LimitTracker({ ...DEFAULT_RUNTIME_LIMITS, ...overrides }, 0, () => nowMs);

  it("counts nodes and throws past the budget", () => {
    const limits = tracker({ maxNodes: 2 });
    limits.registerNode("a");
    limits.registerNode("b");
    expect(() => limits.registerNode("c")).toThrow(LimitExceededError);
    expect(limits.snapshot().nodes).toBe(3);
  });

  it("counts LLM and tool calls separately", () => {
    const limits = tracker({ maxLlmCalls: 1, maxToolCalls: 1 });
    limits.registerLlmCall();
    expect(() => limits.registerLlmCall()).toThrow(LimitExceededError);
    limits.registerToolCall();
    expect(() => limits.registerToolCall()).toThrow(LimitExceededError);
  });

  it("enforces timeout, loop and cost ceilings", () => {
    expect(() => tracker({ maxDurationMs: 10 }, 11).assertWithinDeadline()).toThrow(
      RuntimeTimeoutError,
    );

    const loops = tracker({ maxIterations: 2 });
    expect(loops.registerIteration("loop", 5)).toBe(1);
    expect(loops.registerIteration("loop", 5)).toBe(2);
    expect(() => loops.registerIteration("loop", 5)).toThrow(MaxIterationsError);
    expect(loops.iterationOf("loop")).toBe(3);

    const perLoop = tracker();
    expect(perLoop.registerIteration("loop", 1)).toBe(1);
    expect(() => perLoop.registerIteration("loop", 1)).toThrow(MaxIterationsError);

    const cost = tracker({ maxCostUsd: 0.01 });
    expect(() => cost.registerCost(0.02)).toThrow(LimitExceededError);
    // Unknown cost (null) never trips the budget.
    cost.registerCost(null);
  });
});

describe("execution state machine", () => {
  const state = (): ReturnType<typeof createExecutionState> =>
    createExecutionState({
      runId: "run-1",
      harnessId: "harness-1",
      harnessVersionId: "version-1",
      agentId: null,
      agentVersion: null,
      input: { task: "x" },
      nodeCount: 3,
      edgeCount: 2,
      nodeTypes: ["start", "end"],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

  it("starts queued and allows the documented transitions", () => {
    const initial = state();
    expect(initial.status).toBe("queued");
    expect(initial.metadata.deadlineAt.getTime()).toBe(
      initial.metadata.startedAt.getTime() + DEFAULT_RUNTIME_LIMITS.maxDurationMs,
    );

    const running = transitionExecutionState(initial, "running");
    expect(running.status).toBe("running");
    const finished = finishExecutionState(running, "completed", {
      output: "done",
      at: new Date("2026-01-01T00:00:05.000Z"),
    });
    expect(finished.status).toBe("completed");
    expect(finished.output).toBe("done");
    expect(finished.completedAt).not.toBeNull();
    expect(isTerminalStatus("completed")).toBe(true);
  });

  it("rejects illegal transitions and any move out of a terminal state", () => {
    const initial = state();
    expect(() => transitionExecutionState(initial, "completed")).toThrow(
      InvalidStateTransitionError,
    );

    const completed = finishExecutionState(
      transitionExecutionState(initial, "running"),
      "completed",
      { output: null, at: new Date() },
    );
    expect(() => transitionExecutionState(completed, "running")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("supports cancellation and timeout from running", () => {
    const initial = state();
    const running = transitionExecutionState(initial, "running");
    expect(finishExecutionState(running, "cancelled", { at: new Date() }).status).toBe("cancelled");
    expect(finishExecutionState(running, "timeout", { at: new Date() }).status).toBe("timeout");
  });
});
