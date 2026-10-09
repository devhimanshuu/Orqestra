import { afterEach, describe, expect, it } from "vitest";
import {
  mockProvider,
  queueMockResponses,
  recordedMockRequests,
  resetMockProvider,
} from "@/modules/llm/providers/mock.provider";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { getToolRegistry } from "@/modules/tools";
import type { RuntimeEvent } from "../events/events";
import type { RuntimeAgentContext } from "../nodes/node-executor";
import { NO_RETRY } from "../policies/retry";
import {
  branchingHarness,
  harness,
  edge,
  memoryLoopHarness,
  node,
  researchLoopHarness,
  runFixture,
} from "../testing/fixtures";

const AGENT: RuntimeAgentContext = {
  id: "agent-1",
  version: 3,
  instructions: "You are a rigorous research agent.",
  model: "mock:deterministic",
  capabilities: [],
};

afterEach(() => {
  resetMockProvider();
});

describe("executeHarness — happy path", () => {
  it("executes start → prompt → model → end and records a trace", async () => {
    const definition = harness(
      [
        node("start", "start", "Start"),
        node("prompt", "prompt", "Frame task", { template: "Task: {{ input }}" }),
        node("model", "model", "Draft", { model: "mock:deterministic" }),
        node("end", "end", "End"),
      ],
      [edge("e0", "start", "prompt"), edge("e1", "prompt", "model"), edge("e2", "model", "end")],
    );

    const events: RuntimeEvent[] = [];
    const outcome = await runFixture({
      definition,
      input: "Explain harness engineering",
      agent: AGENT,
      eventSinks: [
        (event) => {
          events.push(event);
        },
      ],
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.persistedStatus).toBe("SUCCEEDED");
    expect(outcome.error).toBeNull();
    expect(outcome.steps.map((step) => step.nodeId)).toEqual(["start", "prompt", "model", "end"]);
    expect(outcome.steps.every((step) => step.status === "succeeded")).toBe(true);
    // The prompt node resolved `{{ input }}` from run state.
    expect(outcome.steps[1]?.output).toMatchObject({
      text: "Task: Explain harness engineering",
    });
    // The model response flowed through to the run output (END unwraps `{ text }`).
    expect(typeof outcome.output).toBe("string");
    expect(String(outcome.output)).toContain("Mock model response");
    expect(outcome.usage.totalTokens).toBeGreaterThan(0);
    expect(outcome.usage.calls).toBe(1);
    expect(outcome.state.variables["task"]).toBe("Explain harness engineering");
    // Deterministic token accounting: the mock provider is free.
    expect(outcome.usage.costUsd).toBe(0);

    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events.at(-1)?.type).toBe("RUN_COMPLETED");
    expect(events.filter((event) => event.type === "NODE_STARTED")).toHaveLength(4);
    expect(events.filter((event) => event.type === "LLM_COMPLETED")).toHaveLength(1);
    // Sequence numbers are monotonic per run.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it("keeps execution independent of persistence hooks", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const statuses: string[] = [];

    const outcome = await runFixture({
      definition: branchingHarness(0.9),
      input: "score me",
      onStepStarted: (step) => void started.push(step.nodeId),
      onStepFinished: (step) => void finished.push(step.nodeId),
      onStatusChange: (state) => void statuses.push(state.status),
    });

    expect(started).toEqual(["start", "seed", "gate", "ok"]);
    expect(finished).toEqual(["start", "seed", "gate", "ok"]);
    expect(statuses).toEqual(["running", "completed"]);
    // END returns whatever flowed into it — here the condition's verdict. A
    // harness that wants a shaped answer puts a Transform/Prompt before END.
    expect(outcome.output).toMatchObject({ result: true });
    expect(outcome.state.variables["input"]).toBe("score me");
  });
});

describe("executeHarness — branching", () => {
  it("follows the true branch of a condition", async () => {
    const outcome = await runFixture({ definition: branchingHarness(0.9), input: "in" });
    expect(outcome.status).toBe("completed");
    expect(outcome.steps.map((step) => step.nodeId)).toEqual(["start", "seed", "gate", "ok"]);
    const gate = outcome.steps.find((step) => step.nodeId === "gate");
    expect(gate?.metadata["branch"]).toBe("true");
    expect(gate?.metadata["result"]).toBe(true);
  });

  it("follows the false branch and records the explanation", async () => {
    const outcome = await runFixture({ definition: branchingHarness(0.2), input: "in" });
    expect(outcome.steps.map((step) => step.nodeId)).toEqual([
      "start",
      "seed",
      "gate",
      "retry_prompt",
      "fail",
    ]);
    const gate = outcome.steps.find((step) => step.nodeId === "gate");
    expect(gate?.metadata["branch"]).toBe("false");
    expect(String(gate?.metadata["explanation"])).toContain("state.score >= 0.8 → false");
  });
});

describe("executeHarness — loop", () => {
  it("iterates the body and leaves through the exit branch when the budget is exhausted", async () => {
    const events: RuntimeEvent[] = [];
    const outcome = await runFixture({
      definition: memoryLoopHarness(2),
      input: "remember this",
      eventSinks: [
        (event) => {
          events.push(event);
        },
      ],
    });

    expect(outcome.status).toBe("completed");
    const loopSteps = outcome.steps.filter((step) => step.nodeId === "loop");
    expect(loopSteps).toHaveLength(3); // body, body, exit
    expect(loopSteps.map((step) => step.metadata["branch"])).toEqual(["body", "body", "exit"]);
    expect(loopSteps.at(-1)?.metadata["exhausted"]).toBe(true);
    expect(outcome.steps.filter((step) => step.nodeId === "remember")).toHaveLength(2);
    expect(outcome.state.variables["iterationsExhausted"]).toBe(true);
    expect(outcome.state.variables["memorySize"]).toBe(2);
    expect(events.filter((event) => event.type === "LOOP_ITERATION")).toHaveLength(2);
  });

  it("runs the canonical research loop end to end with the mock provider", async () => {
    const outcome = await runFixture({
      definition: researchLoopHarness({ maxIterations: 3, threshold: 0.7 }),
      input: "Research the benefits of TypeScript.",
      agent: AGENT,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.steps.map((step) => step.nodeId)).toEqual([
      "start",
      "loop",
      "planner",
      "clock",
      "critic",
      "gate",
      "done",
    ]);
    expect(Array.isArray(outcome.state.variables["plan"])).toBe(true);
    expect(outcome.state.variables["score"]).toBeGreaterThanOrEqual(0.7);
    expect(outcome.state.variables["critiquePassed"]).toBe(true);
    // planner + critic = two LLM calls, one tool call.
    expect(outcome.usage.calls).toBe(2);
    const clockStep = outcome.steps.find((step) => step.nodeId === "clock");
    expect(clockStep?.metadata["toolId"]).toBe("current_time");
  });

  it("fails with MAX_ITERATIONS_EXCEEDED when the run-level ceiling is lower than the loop's", async () => {
    const outcome = await runFixture({
      definition: memoryLoopHarness(5),
      input: "loop",
      limits: { maxIterations: 1 },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MAX_ITERATIONS_EXCEEDED");
    expect(outcome.persistedStatus).toBe("FAILED");
  });
});

describe("executeHarness — tools and permissions", () => {
  const toolHarness = harness(
    [
      node("start", "start", "Start"),
      node("clock", "tool", "Clock", { toolId: "current_time" }),
      node("end", "end", "End"),
    ],
    [edge("e0", "start", "clock"), edge("e1", "clock", "end")],
  );

  it("executes a registered tool", async () => {
    const outcome = await runFixture({ definition: toolHarness, input: "now please" });
    expect(outcome.status).toBe("completed");
    const clock = outcome.steps.find((step) => step.nodeId === "clock");
    expect(clock?.output).toMatchObject({ toolId: "current_time" });
    expect(outcome.state.variables["lastToolId"]).toBe("current_time");
  });

  it("denies a tool the run's permissions do not allow", async () => {
    const events: RuntimeEvent[] = [];
    const outcome = await runFixture({
      definition: toolHarness,
      input: "now please",
      permissions: { mode: "allowlist", allowed: ["calculator"], denied: [] },
      eventSinks: [
        (event) => {
          events.push(event);
        },
      ],
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("PERMISSION_DENIED");
    expect(outcome.error?.nodeId).toBe("clock");
    // A denied tool must never reach the registry, so no TOOL_STARTED is emitted.
    expect(events.some((event) => event.type === "TOOL_STARTED")).toBe(false);
  });

  it("refuses a harness that calls an unregistered tool", async () => {
    const definition = harness(
      [
        node("start", "start", "Start"),
        node("bad", "tool", "Missing tool", { toolId: "not_a_tool" }),
        node("end", "end", "End"),
      ],
      [edge("e0", "start", "bad"), edge("e1", "bad", "end")],
    );

    // Caught at compile time: a run that cannot succeed must not spend tokens.
    await expect(runFixture({ definition, input: "x" })).rejects.toMatchObject({
      code: "HARNESS_NOT_EXECUTABLE",
    });
  });

  it("fails at runtime with a useful error if a tool disappears between compile and call", async () => {
    const { ToolRegistry } = await import("@/modules/tools");
    const { RuntimeToolService } = await import("../services/tool-service");
    const { RuntimeEventEmitter } = await import("../events/event-emitter");
    const { LimitTracker } = await import("../policies/limits");
    const { DEFAULT_RUNTIME_LIMITS } = await import("../state/execution-state");
    const { logger } = await import("@/lib/logging/logger");

    const service = new RuntimeToolService({
      registry: new ToolRegistry(),
      permissions: { mode: "allow_all", allowed: [], denied: [] },
      emitter: new RuntimeEventEmitter("run-1", [], () => new Date(), logger),
      limits: new LimitTracker(DEFAULT_RUNTIME_LIMITS, 0, () => 0),
      logger,
      signal: new AbortController().signal,
    });

    await expect(
      service.execute({ toolId: "gone", input: {}, nodeId: "tool-node" }),
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_ERROR" });
  });
});

describe("executeHarness — model failures, retries and budgets", () => {
  const modelHarness = harness(
    [
      node("start", "start", "Start"),
      node("model", "model", "Draft", { model: "mock:deterministic" }),
      node("end", "end", "End"),
    ],
    [edge("e0", "start", "model"), edge("e1", "model", "end")],
  );

  it("retries a transient provider failure and completes", async () => {
    queueMockResponses(
      { kind: "failure", code: "rate_limited" },
      { kind: "success", content: "Recovered output" },
    );

    const outcome = await runFixture({ definition: modelHarness, input: "x" });
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("Recovered output");
    expect(recordedMockRequests()).toHaveLength(2);
  });

  it("does not retry a permanent provider failure", async () => {
    queueMockResponses({ kind: "failure", code: "provider_error", retryable: false });
    const outcome = await runFixture({ definition: modelHarness, input: "x" });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("LLM_ERROR");
    expect(recordedMockRequests()).toHaveLength(1);
  });

  it("honors an explicit no-retry policy", async () => {
    queueMockResponses({ kind: "failure", code: "rate_limited" });
    const outcome = await runFixture({
      definition: modelHarness,
      input: "x",
      retryPolicy: NO_RETRY,
    });
    expect(outcome.status).toBe("failed");
    expect(recordedMockRequests()).toHaveLength(1);
  });

  it("fails the run when the LLM call budget is exhausted", async () => {
    const outcome = await runFixture({
      definition: modelHarness,
      input: "x",
      limits: { maxLlmCalls: 0 },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("LIMIT_EXCEEDED");
  });

  it("times out when the deadline passes mid-run", async () => {
    let tick = 0;
    const outcome = await runFixture({
      definition: modelHarness,
      input: "x",
      limits: { maxDurationMs: 10 },
      now: () => {
        // Each observation advances 5ms; the deadline (10ms) is crossed after
        // the run started but before the model node completes.
        tick += 5;
        return new Date(tick);
      },
    });
    expect(outcome.status).toBe("timeout");
    expect(outcome.error?.code).toBe("TIMEOUT");
    expect(outcome.persistedStatus).toBe("TIMED_OUT");
    expect(recordedMockRequests()).toHaveLength(0);
  });

  it("stops when the node budget is exhausted", async () => {
    const outcome = await runFixture({
      definition: modelHarness,
      input: "x",
      limits: { maxNodes: 2 },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("LIMIT_EXCEEDED");
  });

  it("refuses a harness with a node type it cannot execute", async () => {
    const definition = harness(
      [
        node("start", "start", "Start"),
        node("approve", "human_approval", "Approve", { instructions: "Check it" }),
        node("end", "end", "End"),
      ],
      [edge("e0", "start", "approve"), edge("e1", "approve", "end")],
    );

    await expect(runFixture({ definition, input: "x" })).rejects.toMatchObject({
      code: "HARNESS_NOT_EXECUTABLE",
    });
  });
});

describe("executeHarness — cancellation", () => {
  it("cancels before doing any work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: RuntimeEvent[] = [];

    const outcome = await runFixture({
      definition: researchLoopHarness(),
      input: "x",
      agent: AGENT,
      signal: controller.signal,
      eventSinks: [
        (event) => {
          events.push(event);
        },
      ],
    });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.error?.code).toBe("CANCELLED");
    expect(outcome.persistedStatus).toBe("CANCELLED");
    expect(outcome.steps).toHaveLength(0);
    expect(recordedMockRequests()).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("RUN_CANCELLED");
  });

  it("cancels mid-run through the cancellation channel", async () => {
    let checks = 0;
    const outcome = await runFixture({
      definition: memoryLoopHarness(2),
      input: "x",
      shouldCancel: () => {
        checks += 1;
        return checks > 2; // let START and one loop pass run, then stop
      },
    });

    expect(outcome.status).toBe("cancelled");
    // START and one loop pass ran; cancellation stopped the body before the
    // memory node ever executed.
    expect(outcome.steps.map((step) => step.nodeId)).toEqual(["start", "loop"]);
    expect(outcome.steps.every((step) => step.status === "succeeded")).toBe(true);
    expect(recordedMockRequests()).toHaveLength(0);
  });
});

describe("executeHarness — reproducibility", () => {
  it("produces identical traces for identical inputs", async () => {
    const first = await runFixture({ definition: branchingHarness(0.9), input: "Same input" });
    const second = await runFixture({ definition: branchingHarness(0.9), input: "Same input" });

    const shape = (outcome: typeof first): unknown =>
      outcome.steps.map((step) => ({
        nodeId: step.nodeId,
        status: step.status,
        output: step.output,
        metadata: step.metadata,
      }));

    expect(shape(first)).toEqual(shape(second));
    expect(first.plan.contentHash).toBe(second.plan.contentHash);
  });

  it("keeps the model provider deterministic for the same request", async () => {
    const gateway = getLLMGateway();
    const request = {
      messages: [{ role: "user" as const, content: "What is 2 + 2?" }],
      metadata: { role: "model" },
    };
    const first = await gateway.generate("mock:deterministic", request);
    const second = await gateway.generate("mock:deterministic", request);

    expect(first.content).toBe(second.content);
    expect(first.usage).toEqual(second.usage);
    expect(getLLMGateway().getProvider(mockProvider.id).id).toBe("mock");
    expect(getToolRegistry().list().map((tool) => tool.id)).toEqual([
      "calculator",
      "json_transform",
      "current_time",
      "http_fetch",
    ]);
  });
});
