import { describe, expect, it } from "vitest";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { LLMRequest, LLMResponse } from "@/modules/llm/llm.types";
import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import type { FailureFindingRecord, OptimizationObjective } from "../optimization.types";
import {
  MAX_LLM_HYPOTHESES,
  buildHypothesisRequest,
  generateLlmHypotheses,
  parseLlmHypotheses,
} from "./llm-generate";

const objective: OptimizationObjective = {
  primary: { metric: "evaluation_score", direction: "maximize" },
  secondary: [{ metric: "estimated_cost_usd", direction: "minimize" }],
  minImprovementPct: 0.05,
  notes: null,
};

function finding(overrides: Partial<FailureFindingRecord> = {}): FailureFindingRecord {
  return {
    id: "f1",
    sessionId: "s1",
    category: "incorrect_final_answer",
    summary: "Answers omit the policy clause.",
    frequency: "3 of 5",
    confidence: "high",
    impact: null,
    investigation: null,
    isLlm: false,
    caseKeys: ["case-a"],
    runIds: [],
    evaluatorKeys: [],
    traceRefs: null,
    hypothesisIds: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const findings = [finding(), finding({ id: "f2", category: "missing_tool_usage" })];

const definition = {
  schemaVersion: 1,
  id: "h1",
  version: 1,
  name: "demo",
  nodes: [
    { id: "start", type: "start", label: "Start", config: {} },
    { id: "model-1", type: "model", label: "Draft", config: { systemPrompt: "Be brief." } },
    { id: "end", type: "end", label: "End", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "model-1" },
    { id: "e2", source: "model-1", target: "end" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
} as unknown as HarnessDefinition;

function stubGateway(content: string): { gateway: LLMGateway; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const response: LLMResponse = {
    provider: "mock",
    model: "deterministic",
    content,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 0,
  };
  return {
    calls,
    gateway: {
      register: () => undefined,
      getProvider: () => {
        throw new Error("unused");
      },
      listProviders: () => [],
      generate: async (_ref, request) => {
        calls.push({ ...request, model: "deterministic" });
        return response;
      },
    },
  };
}

function failingGateway(): LLMGateway {
  return {
    register: () => undefined,
    getProvider: () => {
      throw new Error("unused");
    },
    listProviders: () => [],
    generate: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
}

const validEntry = {
  category: "incorrect_final_answer",
  title: "Demand evidence before answering",
  hypothesis: "Unsupported claims cause the wrong answers.",
  proposedChange: "Append an evidence requirement to the model instructions.",
  expectedOutcome: "Higher answer-correctness on failing cases.",
  tradeoff: "Slightly longer answers.",
  findingIds: ["f1"],
  operations: [
    {
      op: "set_prompt_instruction",
      nodeId: "model-1",
      field: "systemPrompt",
      mode: "append",
      value: "Cite evidence for every claim.",
      reason: "Answers lack evidence.",
    },
  ],
};

describe("parseLlmHypotheses", () => {
  it("accepts a valid hypothesis and fences its metadata", () => {
    const parsed = parseLlmHypotheses(JSON.stringify([validEntry]), findings, objective);
    expect(parsed).toHaveLength(1);
    const hypothesis = parsed[0];
    expect(hypothesis?.origin).toBe("LLM_ASSISTED");
    expect(hypothesis?.confidence).toBe("low");
    expect(hypothesis?.findingIds).toEqual(["f1"]);
    expect(hypothesis?.operations).toHaveLength(1);
    expect(hypothesis?.metricKeys).toEqual(["evaluation_score", "estimated_cost_usd"]);
    expect(hypothesis?.acceptanceCriteria).toMatchObject({ primaryMetric: "evaluation_score" });
  });

  it("accepts the {hypotheses: [...]} envelope", () => {
    const parsed = parseLlmHypotheses(JSON.stringify({ hypotheses: [validEntry] }), findings, objective);
    expect(parsed).toHaveLength(1);
  });

  it("drops hypotheses whose finding ids were never stored", () => {
    const parsed = parseLlmHypotheses(
      JSON.stringify([{ ...validEntry, findingIds: ["ghost-1", "ghost-2"] }]),
      findings,
      objective,
    );
    expect(parsed).toHaveLength(0);
  });

  it("keeps only the real finding ids when mixed", () => {
    const parsed = parseLlmHypotheses(
      JSON.stringify([{ ...validEntry, findingIds: ["f2", "ghost"] }]),
      findings,
      objective,
    );
    expect(parsed[0]?.findingIds).toEqual(["f2"]);
  });

  it("drops out-of-taxonomy categories", () => {
    const parsed = parseLlmHypotheses(
      JSON.stringify([{ ...validEntry, category: "made_up_category" }]),
      findings,
      objective,
    );
    expect(parsed).toHaveLength(0);
  });

  it("drops hypotheses with hallucinated operations", () => {
    const parsed = parseLlmHypotheses(
      JSON.stringify([
        { ...validEntry, operations: [{ op: "delete_everything", nodeId: "x", reason: "y" }] },
      ]),
      findings,
      objective,
    );
    expect(parsed).toHaveLength(0);
  });

  it("drops entries missing the core claim fields", () => {
    const parsed = parseLlmHypotheses(
      JSON.stringify([{ ...validEntry, hypothesis: "" }]),
      findings,
      objective,
    );
    expect(parsed).toHaveLength(0);
  });

  it("still accepts a hypothesis without operations", () => {
    const { operations: _dropped, ...withoutOps } = validEntry;
    const parsed = parseLlmHypotheses(JSON.stringify([withoutOps]), findings, objective);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.operations).toEqual([]);
  });

  it("caps the number of hypotheses", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      ...validEntry,
      title: `Hypothesis ${index}`,
    }));
    const parsed = parseLlmHypotheses(JSON.stringify(many), findings, objective);
    expect(parsed).toHaveLength(MAX_LLM_HYPOTHESES);
  });

  it("returns nothing for unparseable answers", () => {
    expect(parseLlmHypotheses("not json at all", findings, objective)).toEqual([]);
    expect(parseLlmHypotheses(null, findings, objective)).toEqual([]);
  });

  it("marks graph edits as requiring review, prompt edits as not", () => {
    const graphEdit = {
      ...validEntry,
      operations: [
        { op: "remove_node", nodeId: "model-1", reason: "Drop the drafter." },
      ],
    };
    const parsed = parseLlmHypotheses(JSON.stringify([validEntry, graphEdit]), findings, objective);
    expect(parsed[0]?.requiresReview).toBe(false);
    expect(parsed[1]?.requiresReview).toBe(true);
  });
});

describe("buildHypothesisRequest", () => {
  it("names the taxonomy, real finding ids and the mutation rules", () => {
    const prompt = buildHypothesisRequest({ findings, definition, objective, evaluatorConfig: [] });
    expect(prompt.system).toContain("incorrect_final_answer");
    expect(prompt.system).toContain("Respond with JSON only");
    expect(prompt.user).toContain("f1");
    expect(prompt.user).toContain("f2");
    expect(prompt.user).toContain("model-1");
  });
});

describe("generateLlmHypotheses", () => {
  it("parses the model answer and reports usage", async () => {
    const { gateway, calls } = stubGateway(JSON.stringify([validEntry]));
    const result = await generateLlmHypotheses({
      sessionId: "s1",
      analyzerModel: "mock:deterministic",
      findings,
      definition,
      objective,
      evaluatorConfig: [],
      gateway,
    });
    expect(result.error).toBeNull();
    expect(result.hypotheses).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(15);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata?.["purpose"]).toBe("optimization.hypothesis-generation");
  });

  it("never throws when the model fails", async () => {
    const result = await generateLlmHypotheses({
      sessionId: "s1",
      analyzerModel: "mock:deterministic",
      findings,
      definition,
      objective,
      evaluatorConfig: [],
      gateway: failingGateway(),
    });
    expect(result.hypotheses).toEqual([]);
    expect(result.usage).toBeNull();
    expect(result.error).toContain("Analyzer model unavailable");
  });

  it("does nothing without an analyzer model", async () => {
    const { gateway, calls } = stubGateway("[]");
    const result = await generateLlmHypotheses({
      sessionId: "s1",
      analyzerModel: null,
      findings,
      definition,
      objective,
      evaluatorConfig: [],
      gateway,
    });
    expect(result).toEqual({ hypotheses: [], usage: null, error: null });
    expect(calls).toHaveLength(0);
  });

  it("does nothing without findings", async () => {
    const { gateway, calls } = stubGateway("[]");
    const result = await generateLlmHypotheses({
      sessionId: "s1",
      analyzerModel: "mock:deterministic",
      findings: [],
      definition,
      objective,
      evaluatorConfig: [],
      gateway,
    });
    expect(result.hypotheses).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
