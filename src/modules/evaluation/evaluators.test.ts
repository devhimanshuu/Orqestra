import { afterEach, describe, expect, it } from "vitest";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { queueMockResponses, resetMockProvider } from "@/modules/llm/providers/mock.provider";
import {
  listEvaluatorKinds,
  runEvaluator,
  validateEvaluatorConfig,
  type RunEvaluatorInput,
} from "./evaluator.registry";
import { containsEvaluator } from "./evaluators/contains";
import { exactMatchEvaluator } from "./evaluators/exact-match";
import { harnessComplianceEvaluator } from "./evaluators/harness-compliance";
import { jsonSchemaEvaluator } from "./evaluators/json-schema";
import { llmJudgeEvaluator, parseJudgeResponse } from "./evaluators/llm-judge";
import { toolUsageEvaluator } from "./evaluators/tool-usage";
import { makeEvaluationInput, makeObservation, makeStep, makeToolStep } from "./testing/fixtures";
import type { EvaluationContext } from "./evaluation.types";

const context: EvaluationContext = {
  runId: "run-1",
  caseKey: "case-1",
  evaluatorKey: "test@1",
  now: () => new Date("2026-01-01T10:00:00Z"),
};

describe("exact match", () => {
  it("matches after default normalisation", async () => {
    const outcome = await exactMatchEvaluator.evaluate(
      makeEvaluationInput({ output: "  The Answer\r\nIs 42  ", expectedOutput: "the answer\nis 42" }),
      context,
      exactMatchEvaluator.defaultConfig,
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1, passed: true });
  });

  it("respects caseSensitive", async () => {
    const outcome = await exactMatchEvaluator.evaluate(
      makeEvaluationInput({ output: "Answer", expectedOutput: "answer" }),
      context,
      { ...exactMatchEvaluator.defaultConfig, caseSensitive: true },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("can keep whitespace significant", async () => {
    const outcome = await exactMatchEvaluator.evaluate(
      makeEvaluationInput({ output: "a  b", expectedOutput: "a b" }),
      context,
      { ...exactMatchEvaluator.defaultConfig, normalizeWhitespace: false },
    );
    expect(outcome.status).toBe("COMPLETED");
    if (outcome.status === "COMPLETED") {
      expect(outcome.score).toBe(0);
    }
  });

  it("skips — never scores zero — when there is no expected output", async () => {
    const outcome = await exactMatchEvaluator.evaluate(
      makeEvaluationInput({ output: "4", expectedOutput: null }),
      context,
      exactMatchEvaluator.defaultConfig,
    );
    expect(outcome.status).toBe("SKIPPED");
  });

  it("compares JSON-shaped outputs as text", async () => {
    const outcome = await exactMatchEvaluator.evaluate(
      makeEvaluationInput({ output: { a: 1 }, expectedOutput: { a: 1 } }),
      context,
      exactMatchEvaluator.defaultConfig,
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", passed: true });
  });
});

describe("contains", () => {
  const config = { required: ["typescript", "type safety"], prohibited: ["guarantee"], caseSensitive: false, normalizeWhitespace: true };

  it("scores the fraction of required phrases present", async () => {
    const outcome = await containsEvaluator.evaluate(
      makeEvaluationInput({ output: "TypeScript adds type safety to JavaScript." }),
      context,
      config,
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1, passed: true });
  });

  it("scores partial presence and reports what is missing", async () => {
    const outcome = await containsEvaluator.evaluate(
      makeEvaluationInput({ output: "TypeScript is a language." }),
      context,
      config,
    );
    expect(outcome.status).toBe("COMPLETED");
    if (outcome.status === "COMPLETED") {
      expect(outcome.score).toBe(0.5);
      expect(outcome.passed).toBe(false);
      expect(outcome.evidence?.["missing"]).toEqual(["type safety"]);
    }
  });

  it("treats a prohibited phrase as a hard failure", async () => {
    const outcome = await containsEvaluator.evaluate(
      makeEvaluationInput({ output: "TypeScript gives type safety but not a guarantee." }),
      context,
      config,
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("rejects an empty configuration", () => {
    const result = validateEvaluatorConfig("contains", { required: [], prohibited: [] });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/at least one/i);
  });
});

describe("json schema", () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" }, score: { type: "number", minimum: 0, maximum: 1 } },
  };

  it("passes conforming output", async () => {
    const outcome = await jsonSchemaEvaluator.evaluate(
      makeEvaluationInput({ output: '{"answer":"yes","score":0.8}' }),
      context,
      { schema, parseJson: true, maxIssues: 10 },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1, passed: true });
  });

  it("extracts JSON from fenced or chatty output", async () => {
    const outcome = await jsonSchemaEvaluator.evaluate(
      makeEvaluationInput({ output: 'Here you go:\n```json\n{"answer":"yes"}\n```' }),
      context,
      { schema, parseJson: true, maxIssues: 10 },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1 });
  });

  it("fails non-JSON output without inventing a schema result", async () => {
    const outcome = await jsonSchemaEvaluator.evaluate(
      makeEvaluationInput({ output: "not json at all" }),
      context,
      { schema, parseJson: true, maxIssues: 10 },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("reports schema violations with paths", async () => {
    const outcome = await jsonSchemaEvaluator.evaluate(
      makeEvaluationInput({ output: '{"score":5}' }),
      context,
      { schema, parseJson: true, maxIssues: 10 },
    );
    expect(outcome.status).toBe("COMPLETED");
    if (outcome.status === "COMPLETED") {
      expect(outcome.score).toBe(0);
      expect(JSON.stringify(outcome.evidence)).toContain("/answer");
      expect(JSON.stringify(outcome.evidence)).toContain("/score");
    }
  });
});

describe("tool usage", () => {
  const steps = [
    makeToolStep("calculator", { index: 1 }),
    makeToolStep("calculator", { index: 2 }),
    makeToolStep("current_time", { index: 3 }),
    makeStep({ index: 4 }),
  ];

  it("passes when required tools are called and prohibited ones are not", async () => {
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      { required: ["calculator"], prohibited: ["http_fetch"], minCalls: { calculator: 2 }, maxCalls: { calculator: 3 } },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1, passed: true });
  });

  it("fails when a required tool is missing", async () => {
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      { required: ["http_fetch"], prohibited: [], minCalls: {}, maxCalls: {} },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
    if (outcome.status === "COMPLETED") {
      expect(outcome.evidence?.["missing"]).toEqual(["http_fetch"]);
    }
  });

  it("fails when a prohibited tool was called", async () => {
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      { required: [], prohibited: ["current_time"], minCalls: {}, maxCalls: {} },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("enforces a minimum call count", async () => {
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      { required: [], prohibited: [], minCalls: { calculator: 3 }, maxCalls: {} },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("enforces a maximum call count", async () => {
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      { required: [], prohibited: [], minCalls: {}, maxCalls: { calculator: 1 } },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("treats a min above a max as a configuration error, not a failed agent", async () => {
    const record = await runEvaluator({
      kind: "tool_usage",
      evaluatorKey: "tools@1",
      evaluatorName: "Tools",
      config: { required: [], prohibited: [], minCalls: { calculator: 5 }, maxCalls: { calculator: 1 } },
      input: makeEvaluationInput({ observation: { steps } }),
      context,
    });
    expect(record.status).toBe("ERROR");
    expect(record.metadata?.["retryable"]).toBe(false);
  });

  it("counts only tool nodes as tool invocations", async () => {
    const mixed = [
      makeToolStep("calculator"),
      makeStep({ nodeType: "model", nodeLabel: "Model", index: 1 }),
    ];
    const outcome = await toolUsageEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps: mixed } }),
      context,
      { required: [], prohibited: [], minCalls: {}, maxCalls: { calculator: 1 } },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", passed: true });
  });
});

describe("harness compliance", () => {
  const steps = [
    makeStep({ nodeId: "start", nodeType: "start", status: "SUCCEEDED", index: 0 }),
    makeStep({ nodeId: "planner", nodeType: "planner", status: "SUCCEEDED", index: 1 }),
    makeStep({ nodeId: "critic", nodeType: "critic", status: "FAILED", index: 2, error: { code: "NODE_FAILED", message: "boom" } }),
  ];

  it("checks required nodes, node types and prohibitions", async () => {
    const outcome = await harnessComplianceEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      {
        requiredNodes: ["planner"],
        prohibitedNodes: ["human_approval"],
        requiredNodeTypes: ["critic"],
        maxNodeAttempts: { planner: 2 },
        requireSucceededRun: false,
      },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 1, passed: true });
  });

  it("reports a required node that never ran", async () => {
    const outcome = await harnessComplianceEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps } }),
      context,
      {
        requiredNodes: ["verifier"],
        prohibitedNodes: [],
        requiredNodeTypes: [],
        maxNodeAttempts: {},
        requireSucceededRun: false,
      },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
    if (outcome.status === "COMPLETED") {
      expect(outcome.evidence?.["missingNodes"]).toEqual(["verifier"]);
    }
  });

  it("detects excessive node attempts (loop runaway)", async () => {
    const repeated = [
      makeStep({ nodeId: "planner", index: 0 }),
      makeStep({ nodeId: "planner", index: 1 }),
      makeStep({ nodeId: "planner", index: 2 }),
    ];
    const outcome = await harnessComplianceEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps: repeated } }),
      context,
      {
        requiredNodes: [],
        prohibitedNodes: [],
        requiredNodeTypes: [],
        maxNodeAttempts: { planner: 2 },
        requireSucceededRun: false,
      },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", passed: false });
  });

  it("can require the run itself to have succeeded", async () => {
    const outcome = await harnessComplianceEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps, status: "FAILED" } }),
      context,
      {
        requiredNodes: [],
        prohibitedNodes: [],
        requiredNodeTypes: [],
        maxNodeAttempts: {},
        requireSucceededRun: true,
      },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0, passed: false });
  });

  it("uses real execution order, not harness node order", async () => {
    const outOfOrder = [
      makeStep({ nodeId: "b", index: 5 }),
      makeStep({ nodeId: "a", index: 9 }),
    ];
    const outcome = await harnessComplianceEvaluator.evaluate(
      makeEvaluationInput({ observation: { steps: outOfOrder } }),
      context,
      {
        requiredNodes: ["a", "b"],
        prohibitedNodes: [],
        requiredNodeTypes: [],
        maxNodeAttempts: {},
        requireSucceededRun: false,
      },
    );
    expect(outcome).toMatchObject({ status: "COMPLETED", passed: true });
  });
});

describe("llm judge", () => {
  afterEach(() => {
    resetMockProvider();
  });

  it("parses a well-formed verdict and labels it as a judgement", async () => {
    queueMockResponses({
      kind: "success",
      content: JSON.stringify({ score: 0.9, verdict: "Meets the rubric", explanation: "Cited the source." }),
      usage: { promptTokens: 120, completionTokens: 30 },
    });
    const outcome = await llmJudgeEvaluator.evaluate(makeEvaluationInput({}), {
      ...context,
      llm: { gateway: getLLMGateway() },
    }, {
      rubric: "The answer must cite at least one source and be at least twenty characters long.",
      model: "mock:deterministic",
      minScore: 0.7,
      includeExpected: true,
      timeoutMs: 5_000,
    });

    expect(outcome).toMatchObject({ status: "COMPLETED", score: 0.9, passed: true });
    if (outcome.status === "COMPLETED") {
      expect(outcome.explanation).toMatch(/LLM judge/);
      expect(outcome.evidence?.["judgement"]).toBe(true);
      expect(outcome.metadata?.["totalTokens"]).toBe(150);
      expect(outcome.metadata?.["costUsd"]).toBe(0);
      expect(outcome.metadata?.["model"]).toBe("mock:deterministic");
    }
  });

  it("rejects a malformed verdict instead of guessing a score", async () => {
    queueMockResponses({ kind: "success", content: "Sure! The answer is probably fine." });
    const record = await runEvaluator({
      kind: "llm_judge",
      evaluatorKey: "judge@1",
      evaluatorName: "Judge",
      config: { rubric: "The answer must be correct and concise, at least ten chars.", model: "mock:deterministic" },
      input: makeEvaluationInput({}),
      context: { ...context, llm: { gateway: getLLMGateway() } },
    });
    expect(record.status).toBe("ERROR");
    expect(record.score).toBeNull();
    expect(record.explanation).toMatch(/not valid JSON|shape/i);
  });

  it("rejects a verdict whose score is out of range", async () => {
    queueMockResponses({ kind: "success", content: JSON.stringify({ score: 42, explanation: "everything" }) });
    const record = await runEvaluator({
      kind: "llm_judge",
      evaluatorKey: "judge@1",
      evaluatorName: "Judge",
      config: { rubric: "The answer must be correct and concise, at least ten chars.", model: "mock:deterministic" },
      input: makeEvaluationInput({}),
      context: { ...context, llm: { gateway: getLLMGateway() } },
    });
    expect(record.status).toBe("ERROR");
    expect(record.explanation).toMatch(/shape/i);
  });

  it("records a provider failure as a retryable error", async () => {
    queueMockResponses({ kind: "failure", code: "rate_limited", retryable: true });
    const record = await runEvaluator({
      kind: "llm_judge",
      evaluatorKey: "judge@1",
      evaluatorName: "Judge",
      config: { rubric: "The answer must be correct and concise, at least ten chars.", model: "mock:deterministic" },
      input: makeEvaluationInput({}),
      context: { ...context, llm: { gateway: getLLMGateway() } },
    });
    expect(record.status).toBe("ERROR");
    expect(record.metadata?.["retryable"]).toBe(true);
  });

  it("errors when no gateway was supplied", async () => {
    const record = await runEvaluator({
      kind: "llm_judge",
      evaluatorKey: "judge@1",
      evaluatorName: "Judge",
      config: { rubric: "The answer must be correct and concise, at least ten chars.", model: "mock:deterministic" },
      input: makeEvaluationInput({}),
      context,
    });
    expect(record.status).toBe("ERROR");
    expect(record.explanation).toMatch(/gateway/i);
  });

  it("parses fenced JSON verdicts", () => {
    const parsed = parseJudgeResponse('```json\n{"score":0.5,"explanation":"half"}\n```');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.verdict.score).toBe(0.5);
    }
  });
});

describe("runEvaluator", () => {
  const base: Omit<RunEvaluatorInput, "kind" | "config"> = {
    evaluatorKey: "exact@1",
    evaluatorName: "Exact",
    input: makeEvaluationInput({ output: "4", expectedOutput: "4" }),
    context,
  };

  it("runs a registered evaluator and returns persisted shape", async () => {
    const record = await runEvaluator({ ...base, kind: "exact_match", config: {} });
    expect(record).toMatchObject({
      evaluatorKey: "exact@1",
      kind: "exact_match",
      status: "COMPLETED",
      score: 1,
      maxScore: 1,
      normalizedScore: 1,
      passed: true,
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects unknown kinds without throwing", async () => {
    const record = await runEvaluator({ ...base, kind: "not_a_kind", config: {} });
    expect(record.status).toBe("ERROR");
    expect(record.explanation).toMatch(/No evaluator/);
    expect(record.metadata?.["retryable"]).toBe(false);
  });

  it("rejects unknown config keys (strict schemas)", async () => {
    const record = await runEvaluator({ ...base, kind: "exact_match", config: { casSensitive: true } });
    expect(record.status).toBe("ERROR");
    expect(record.explanation).toMatch(/Invalid configuration/);
  });

  it("applies defaults when config is omitted", async () => {
    const record = await runEvaluator({ ...base, kind: "exact_match", config: undefined });
    expect(record.status).toBe("COMPLETED");
  });

  it("marks a skipped evaluator as SKIPPED with no score", async () => {
    const record = await runEvaluator({
      ...base,
      input: makeEvaluationInput({ output: "4", expectedOutput: null }),
      kind: "exact_match",
      config: {},
    });
    expect(record).toMatchObject({ status: "SKIPPED", score: null, normalizedScore: null });
  });

  it("surfaces an evaluator bug as an ERROR without touching the run", async () => {
    const observation = makeObservation({ status: "FAILED", error: { code: "NODE_FAILED", message: "boom" } });
    const record = await runEvaluator({
      ...base,
      kind: "json_schema",
      config: { schema: { $ref: "#/definitions/x" }, parseJson: true },
      input: makeEvaluationInput({ observation, output: "anything" }),
    });
    expect(record.status).toBe("ERROR");
    expect(record.explanation).toMatch(/unsupported keyword/i);
    // The run's own record is untouched by the evaluator failing.
    expect(observation.status).toBe("FAILED");
    expect(observation.error?.code).toBe("NODE_FAILED");
  });
});

describe("registry", () => {
  it("exposes all six built-in kinds", () => {
    const kinds = listEvaluatorKinds().map((entry) => entry.kind);
    expect(kinds).toEqual([
      "exact_match",
      "contains",
      "json_schema",
      "tool_usage",
      "harness_compliance",
      "llm_judge",
    ]);
  });

  it("validates configuration without running it", () => {
    const ok = validateEvaluatorConfig("llm_judge", { rubric: "A rubric of sufficient length.", model: "mock:deterministic" });
    expect(ok.ok).toBe(true);
    const bad = validateEvaluatorConfig("llm_judge", { rubric: "short", model: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.issues.length).toBeGreaterThan(0);
  });
});
