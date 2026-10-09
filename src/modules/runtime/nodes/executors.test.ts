import { afterEach, describe, expect, it } from "vitest";
import {
  queueMockResponses,
  recordedMockRequests,
  resetMockProvider,
} from "@/modules/llm/providers/mock.provider";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { getToolRegistry } from "@/modules/tools";
import { logger } from "@/lib/logging/logger";
import { RuntimeEventEmitter } from "../events/event-emitter";
import { LimitTracker } from "../policies/limits";
import { UsageTracker } from "../usage/tracker";
import {
  createExecutionState,
  DEFAULT_RUNTIME_LIMITS,
  type ExecutionState,
} from "../state/execution-state";
import { createRuntimeServices } from "../services/runtime-services";
import { buildExpressionScope } from "../executor/scope";
import type { RuntimeNodeServices, RuntimeNode, RuntimeAgentContext } from "./node-executor";
import { ValidationError } from "../errors/runtime-error";
import { createNodeExecutorRegistry, DSL_NODE_TYPES } from "./registry";

const AGENT: RuntimeAgentContext = {
  id: "agent-1",
  version: 1,
  instructions: "You are a precise assistant.",
  model: "mock:deterministic",
  capabilities: [],
};

afterEach(() => {
  resetMockProvider();
});

interface Harness {
  run: (
    node: RuntimeNode,
    input: unknown,
    options?: { state?: ExecutionState; services?: Partial<RuntimeNodeServices>; outgoing?: Array<{ edgeId: string; target: string; label: string | null }> },
  ) => Promise<unknown>;
  state: (patch?: Record<string, unknown>) => ExecutionState;
  services: RuntimeNodeServices;
}

function createHarness(): Harness {
  const state = createExecutionState({
    runId: "run-1",
    harnessId: "harness-1",
    harnessVersionId: "version-1",
    agentId: "agent-1",
    agentVersion: 1,
    input: "run input",
    nodeCount: 4,
    edgeCount: 3,
    nodeTypes: ["start", "model", "end"],
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  state.status = "running";

  const emitter = new RuntimeEventEmitter("run-1", [], () => new Date("2026-01-01T00:00:01.000Z"), logger);
  const limits = new LimitTracker(DEFAULT_RUNTIME_LIMITS, 0, () => 0);
  const { services } = createRuntimeServices({
    gateway: getLLMGateway(),
    toolRegistry: getToolRegistry(),
    permissions: { mode: "allow_all", allowed: [], denied: [] },
    emitter,
    limits,
    usage: new UsageTracker(),
    logger,
    signal: new AbortController().signal,
    now: () => new Date("2026-01-01T00:00:01.000Z"),
    state,
    agent: AGENT,
  });

  const registry = createNodeExecutorRegistry();

  return {
    state: (patch = {}) => {
      state.variables = { ...state.variables, ...patch };
      return state;
    },
    services,
    run: async (node, input, options = {}) => {
      const target = options.state ?? state;
      if (options.state !== undefined) {
        // Rebuild services against the supplied state so `context.services.state`
        // matches the state under test.
        const rebuilt = createRuntimeServices({
          gateway: getLLMGateway(),
          toolRegistry: getToolRegistry(),
          permissions: { mode: "allow_all", allowed: [], denied: [] },
          emitter,
          limits,
          usage: new UsageTracker(),
          logger,
          signal: new AbortController().signal,
          now: () => new Date("2026-01-01T00:00:01.000Z"),
          state: target,
          agent: AGENT,
        }).services;
        return registry.get(node.type).execute(
          {
            run: { id: target.runId, harnessId: target.harnessId, harnessVersionId: target.harnessVersionId, iteration: 0 },
            node,
            input,
            outgoing: options.outgoing ?? [],
            scope: buildExpressionScope({ state: target, previous: { nodeId: null, output: input }, iteration: 0, now: new Date() }),
            services: rebuilt,
          },
          node.config,
        );
      }
      return registry.get(node.type).execute(
        {
          run: { id: target.runId, harnessId: target.harnessId, harnessVersionId: target.harnessVersionId, iteration: 0 },
          node,
          input,
          outgoing: options.outgoing ?? [],
          scope: buildExpressionScope({ state: target, previous: { nodeId: null, output: input }, iteration: 0, now: new Date() }),
          services: { ...services, ...options.services },
        },
        node.config,
      );
    },
  };
}

const node = (type: RuntimeNode["type"], config: Record<string, unknown> = {}, label = "Node"): RuntimeNode => ({
  id: label.toLowerCase().replace(/\s+/g, "_"),
  type,
  label,
  config,
});

describe("registry", () => {
  it("has an executor for every node type the DSL declares", () => {
    const registry = createNodeExecutorRegistry();
    for (const type of DSL_NODE_TYPES) {
      expect(registry.has(type)).toBe(true);
    }
    // human_approval has an executor too — it is refused by executability rules,
    // not by a missing implementation, so the error message stays specific.
    expect(registry.types()).toHaveLength(DSL_NODE_TYPES.length);
  });
});

describe("control nodes", () => {
  it("start publishes the run input and a convenience task string", async () => {
    const harness = createHarness();
    const result = (await harness.run(node("start"), "Research TypeScript")) as {
      output: unknown;
      state: Record<string, unknown>;
    };
    expect(result.output).toBe("Research TypeScript");
    expect(result.state["task"]).toBe("Research TypeScript");
  });

  it("end unwraps a model's { text } output and passes objects through", async () => {
    const harness = createHarness();
    expect(
      (await harness.run(node("end"), { text: "final answer", provider: "mock" })) as {
        output: unknown;
      },
    ).toMatchObject({ output: "final answer" });
    expect(await harness.run(node("end"), { plan: [] })).toMatchObject({ output: { plan: [] } });
  });
});

describe("prompt, context and transform nodes", () => {
  it("prompt resolves templates from run state", async () => {
    const harness = createHarness();
    harness.state({ score: 0.75 });
    const result = (await harness.run(node("prompt", { template: "Score is {{ state.score }}" }, "Prompt"), "x")) as {
      output: { text: string };
      state: Record<string, unknown>;
    };
    expect(result.output.text).toBe("Score is 0.75");
    expect(result.state["prompt"]).toBe("Score is 0.75");
  });

  it("context sources read the agent, the run input, state and static values", async () => {
    const harness = createHarness();
    const instructions = (await harness.run(
      node("context", { source: "agent_instructions" }, "Instructions"),
      null,
    )) as { output: { text: string } };
    expect(instructions.output.text).toBe("You are a precise assistant.");

    const input = (await harness.run(node("context", { source: "run_input" }, "Input"), null)) as {
      output: { text: string };
    };
    expect(input.output.text).toBe("run input");

    const staticValue = (await harness.run(
      node("context", { source: "static", value: "fixed guidance" }, "Static"),
      null,
    )) as { output: { text: string } };
    expect(staticValue.output.text).toBe("fixed guidance");

    const truncated = (await harness.run(
      node("context", { source: "static", value: "x".repeat(400), maxTokens: 10 }, "Tiny"),
      null,
    )) as { output: { text: string; truncated: boolean } };
    expect(truncated.output.truncated).toBe(true);
    expect(truncated.output.text.length).toBeLessThanOrEqual(40);
  });

  it("context refuses a static source without a value", async () => {
    const harness = createHarness();
    await expect(
      harness.run(node("context", { source: "static" }, "Missing"), null),
    ).rejects.toThrow(ValidationError);
  });

  it("transform maps object templates with typed literals and state paths", async () => {
    const harness = createHarness();
    harness.state({ draft: "draft text", count: 3 });
    const mapped = (await harness.run(
      node("transform", { expression: "{ answer: state.draft, total: 2, flag: true }" }, "Map"),
      "in",
    )) as { output: Record<string, unknown>; state: Record<string, unknown> };
    expect(mapped.output).toEqual({ answer: "draft text", total: 2, flag: true });
    expect(mapped.state).toMatchObject({ answer: "draft text" });

    const value = (await harness.run(
      node("transform", { expression: "{{ state.draft }}" }, "Value"),
      "in",
    )) as { output: unknown };
    expect(value.output).toBe("draft text");
  });
});

describe("memory node", () => {
  it("accumulates run-scoped memory and honours maxItems", async () => {
    const harness = createHarness();
    await harness.run(node("memory", { scope: "run", maxItems: 2 }, "Memory"), "first");
    await harness.run(node("memory", { scope: "run", maxItems: 2 }, "Memory"), "second");
    const third = (await harness.run(
      node("memory", { scope: "run", maxItems: 2 }, "Memory"),
      "third",
    )) as { output: { items: unknown[]; size: number } };
    expect(third.output.size).toBe(2);
    expect(third.output.items).toEqual(["second", "third"]);
  });
});

describe("condition, router and loop nodes", () => {
  it("condition selects a branch and validates its expression up front", async () => {
    const harness = createHarness();
    const registry = createNodeExecutorRegistry();
    harness.state({ score: 0.5 });
    const result = (await harness.run(
      node("condition", { expression: "state.score >= 0.8" }, "Gate"),
      "in",
    )) as { branch: string; output: { result: boolean } };
    expect(result.branch).toBe("false");
    expect(result.output.result).toBe(false);

    expect(() => registry.validate(node("condition", { expression: "state.score >=" }, "Bad"))).toThrow(
      ValidationError,
    );
  });

  it("router follows state.route to a target, its label, and falls back to the first edge", async () => {
    const harness = createHarness();
    const outgoing = [
      { edgeId: "e1", target: "fast", label: "Fast path" },
      { edgeId: "e2", target: "slow", label: "Slow path" },
    ];

    harness.state({});
    const fallback = (await harness.run(
      node("router", { instructions: "pick" }, "Router"),
      "in",
      { outgoing },
    )) as { nextNodeId: string; metadata: { reason: string } };
    expect(fallback.nextNodeId).toBe("fast");
    expect(fallback.metadata.reason).toContain("first declared");

    harness.state({ route: "slow" });
    expect(
      ((await harness.run(node("router", { instructions: "pick" }, "Router"), "in", { outgoing })) as {
        nextNodeId: string;
      }).nextNodeId,
    ).toBe("slow");

    harness.state({ route: "Slow path" });
    expect(
      ((await harness.run(node("router", { instructions: "pick" }, "Router"), "in", { outgoing })) as {
        nextNodeId: string;
      }).nextNodeId,
    ).toBe("slow");

    harness.state({ route: "nope" });
    const unmatched = (await harness.run(node("router", { instructions: "pick" }, "Router"), "in", {
      outgoing,
    })) as { nextNodeId: string; warnings?: string[] };
    expect(unmatched.nextNodeId).toBe("fast");
    expect(unmatched.warnings?.[0]).toContain("matched no outgoing edge");
  });

  it("loop counts iterations, then takes the exit branch", async () => {
    const harness = createHarness();
    const loop = node("loop", { maxIterations: 2 }, "Loop");

    expect(await harness.run(loop, "in")).toMatchObject({ branch: "body" });
    expect(await harness.run(loop, "in")).toMatchObject({ branch: "body" });
    expect(await harness.run(loop, "in")).toMatchObject({
      branch: "exit",
      output: { exhausted: true, iteration: 2 },
    });
  });
});

describe("AI nodes", () => {
  it("model calls the mock provider and reports usage", async () => {
    const harness = createHarness();
    const result = (await harness.run(
      node("model", { model: "mock:deterministic", systemPrompt: "Be terse." }, "Draft"),
      "Explain the plan",
    )) as { output: { text: string; provider: string }; usage: { totalTokens: number } };

    expect(result.output.provider).toBe("mock");
    expect(result.output.text).toContain("Mock model response");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(recordedMockRequests()[0]?.messages[0]).toEqual({ role: "system", content: "Be terse." });
  });

  it("model requires a provider:model reference", async () => {
    const harness = createHarness();
    const registry = createNodeExecutorRegistry();
    expect(() => registry.validate(node("model", { model: "gemini-2.0-flash" }, "Bad"))).toThrow(
      ValidationError,
    );
    expect(() => registry.validate(node("model", { provider: "gemini", model: "gemini-2.0-flash" }, "Ok"))).not.toThrow();
    await expect(
      harness.run(node("model", { model: "bogus" }, "Bad"), "x"),
    ).rejects.toThrow(ValidationError);
  });

  it("planner parses structured JSON and writes the plan to state", async () => {
    const harness = createHarness();
    const result = (await harness.run(
      node("planner", { instructions: "Plan it", maxSteps: 3 }, "Planner"),
      "Plan a research task",
    )) as { output: { plan: string[]; stepCount: number }; state: Record<string, unknown> };

    expect(result.output.plan.length).toBeGreaterThan(0);
    expect(result.output.plan.length).toBeLessThanOrEqual(3);
    expect(result.state["plan"]).toEqual(result.output.plan);
  });

  it("planner repairs once, then fails when the model never returns JSON", async () => {
    queueMockResponses(
      { kind: "success", content: "Here is a plan: do the thing" },
      { kind: "success", content: "Still not JSON" },
    );
    const harness = createHarness();
    await expect(
      harness.run(node("planner", { instructions: "Plan it" }, "Planner"), "task"),
    ).rejects.toThrow(ValidationError);
    expect(recordedMockRequests()).toHaveLength(2);
  });

  it("critic scores output and applies the threshold", async () => {
    queueMockResponses({
      kind: "success",
      content: JSON.stringify({ score: 0.42, issues: ["thin evidence"], summary: "Needs work" }),
    });
    const harness = createHarness();
    const result = (await harness.run(
      node("critic", { instructions: "Review", threshold: 0.7 }, "Critic"),
      "candidate answer",
    )) as { output: { passed: boolean; score: number }; state: Record<string, unknown>; warnings?: string[] };

    expect(result.output.score).toBe(0.42);
    expect(result.output.passed).toBe(false);
    expect(result.state["critique"]).toBe("Needs work");
    expect(result.warnings?.[0]).toContain("below the 0.7 threshold");
  });

  it("critic fails when the model returns no score", async () => {
    queueMockResponses({ kind: "success", content: JSON.stringify({ summary: "looks fine" }) });
    const harness = createHarness();
    await expect(
      harness.run(node("critic", { instructions: "Review" }, "Critic"), "draft"),
    ).rejects.toThrow(ValidationError);
  });

  it("evaluator records a metric score", async () => {
    queueMockResponses({
      kind: "success",
      content: JSON.stringify({ score: 0.88, rationale: "well grounded" }),
    });
    const harness = createHarness();
    const result = (await harness.run(
      node("evaluator", { instructions: "Score it", metric: "groundedness" }, "Evaluator"),
      "draft",
    )) as { output: { metric: string; score: number }; state: Record<string, unknown> };

    expect(result.output).toMatchObject({ metric: "groundedness", score: 0.88 });
    expect(result.state["evaluationMetric"]).toBe("groundedness");
  });

  it("inherited-model nodes fail clearly when the agent has no model", async () => {
    const harness = createHarness();
    const state = harness.state();
    await expect(
      harness.run(node("planner", { instructions: "Plan" }, "Planner"), "task", {
        services: { agent: { ...AGENT, model: null } },
      }),
    ).rejects.toThrow(/needs a model/);
    expect(state).toBeDefined();
  });
});

describe("tool node", () => {
  it("executes a tool with an explicit resolved input", async () => {
    const harness = createHarness();
    harness.state({ calculation: "2 + 5 * 10" });
    const result = (await harness.run(
      node("tool", { toolId: "calculator", input: { expression: "{{ state.calculation }}" } }, "Calc"),
      "ignored",
    )) as { output: { result: number; toolId: string } };

    expect(result.output.toolId).toBe("calculator");
    expect(result.output.result).toBe(52);
  });

  it("resolves expressions against the incoming value and the tool's own output", async () => {
    const harness = createHarness();
    const result = (await harness.run(
      node(
        "tool",
        {
          toolId: "json_transform",
          input: { source: "{{ previous.output }}", operations: [{ op: "count" }] },
        },
        "Count",
      ),
      [1, 2, 3],
    )) as { output: { value: number; operations: string[]; toolResult: unknown } };

    // Tool output fields are spread outward (`{{ count.value }}`) and the raw
    // tool result stays available under the namespaced `toolResult`.
    expect(result.output.value).toBe(3);
    expect(result.output.operations).toEqual(["count"]);
    expect(result.output.toolResult).toEqual({ value: 3, operations: ["count"] });
  });
});
