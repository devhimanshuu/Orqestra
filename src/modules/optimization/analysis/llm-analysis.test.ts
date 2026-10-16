import { describe, expect, it, vi } from "vitest";
import { LLMProviderError, type LLMRequest, type LLMResponse } from "@/modules/llm/llm.types";
import { mockProvider } from "@/modules/llm/providers/mock.provider";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { FindingDraft } from "./failure-analysis";
import {
  MAX_LLM_FINDINGS,
  analyzeSemantically,
  buildAnalysisRequest,
  parseLlmFindings,
} from "./llm-analysis";

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    category: "incorrect_final_answer",
    summary: "Two cases answer the wrong policy question.",
    frequency: "2 of 3 case(s)",
    confidence: "high",
    impact: "The harness's quality ceiling.",
    investigation: "Read the answer steps.",
    isLlm: false,
    caseKeys: ["case-a", "case-b"],
    runIds: ["run-1"],
    evaluatorKeys: ["exact_match"],
    traceRefs: [{ caseKey: "case-a", runId: "run-1", stepIndexes: [1], note: "the drafter step" }],
    ...overrides,
  };
}

function response(content: string): LLMResponse {
  return {
    provider: "mock",
    model: "deterministic",
    content,
    finishReason: "stop",
    usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    latencyMs: 0,
  };
}

function stubGateway(
  respond: (request: Omit<LLMRequest, "model">) => LLMResponse | Promise<LLMResponse>,
): { gateway: LLMGateway; calls: Omit<LLMRequest, "model">[] } {
  const calls: Omit<LLMRequest, "model">[] = [];
  return {
    calls,
    gateway: {
      register: () => undefined,
      getProvider: () => mockProvider,
      listProviders: () => [],
      generate: async (_ref, request) => {
        calls.push(request);
        return respond(request);
      },
    },
  };
}

describe("parseLlmFindings", () => {
  const observed = ["case-a", "case-b"];

  it("stores every accepted finding as a labelled hypothesis", () => {
    const findings = parseLlmFindings(
      [{ category: "incorrect_final_answer", summary: "All wrong answers miss the policy clause.", caseKeys: ["case-a"] }],
      observed,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidence).toBe("llm");
    expect(findings[0]?.isLlm).toBe(true);
    expect(findings[0]?.investigation).toContain("lead");
  });

  it("drops categories outside the taxonomy", () => {
    const findings = parseLlmFindings(
      [
        { category: "vibes_are_off", summary: "Something feels wrong.", caseKeys: ["case-a"] },
        { category: "repeated_tool_calls", summary: "The same lookup repeats.", caseKeys: ["case-b"] },
      ],
      observed,
    );
    expect(findings.map((finding) => finding.category)).toEqual(["repeated_tool_calls"]);
  });

  it("drops a claim that names no observed case", () => {
    expect(parseLlmFindings([{ category: "incorrect_final_answer", summary: "Generally weak." }], observed)).toEqual([]);
    expect(parseLlmFindings([{ category: "incorrect_final_answer", summary: "Generally weak.", caseKeys: [] }], observed)).toEqual([]);
  });

  it("keeps the observed case keys and discards invented ones", () => {
    const findings = parseLlmFindings(
      [{ category: "incorrect_final_answer", summary: "Pattern.", caseKeys: ["case-a", "case-zzz", 7] }],
      observed,
    );
    expect(findings[0]?.caseKeys).toEqual(["case-a"]);
  });

  it("never invents run, evaluator or trace evidence", () => {
    const findings = parseLlmFindings(
      [{ category: "incorrect_final_answer", summary: "Pattern.", caseKeys: ["case-a"] }],
      observed,
    );
    expect(findings[0]?.runIds).toEqual([]);
    expect(findings[0]?.evaluatorKeys).toEqual([]);
    expect(findings[0]?.traceRefs).toEqual([]);
  });

  it("reads a fenced JSON block out of prose", () => {
    const content = ['Here is my analysis:', "```json", '[{"category":"excessive_latency","summary":"Slow.", "caseKeys":["case-b"]}]', "```"].join("\n");
    const findings = parseLlmFindings(content, observed);
    expect(findings.map((finding) => finding.category)).toEqual(["excessive_latency"]);
  });

  it("returns nothing for unparseable or non-array content", () => {
    expect(parseLlmFindings("I could not analyse this batch.", observed)).toEqual([]);
    expect(parseLlmFindings({ category: "incorrect_final_answer" }, observed)).toEqual([]);
    expect(parseLlmFindings("[{not json]", observed)).toEqual([]);
  });

  it("caps how many findings a single answer may add", () => {
    const many = Array.from({ length: MAX_LLM_FINDINGS + 4 }, (_value, index) => ({
      category: "incorrect_final_answer",
      summary: `Pattern ${index}`,
      caseKeys: ["case-a"],
    }));
    expect(parseLlmFindings(many, observed)).toHaveLength(MAX_LLM_FINDINGS);
  });
});

describe("buildAnalysisRequest", () => {
  it("states the taxonomy and the cases the model may cite", () => {
    const request = buildAnalysisRequest({ findings: [draft()], batchId: "batch-1", caseCount: 3 });
    expect(request.user).toContain("batch-1");
    expect(request.user).toContain("case-a");
    expect(request.system).toContain("incorrect_final_answer");
    expect(request.system).toContain("repeated_tool_calls");
    expect(request.system).toContain("JSON only");
  });
});

describe("analyzeSemantically", () => {
  it("does not call the model when the analyzer is disabled", async () => {
    const { gateway, calls } = stubGateway(() => response("[]"));
    const result = await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: null,
      findings: [draft()],
      observedCaseKeys: ["case-a"],
      gateway,
    });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ findings: [], usage: null, error: null });
  });

  it("does not call the model when there is nothing deterministic to summarise", async () => {
    const { gateway, calls } = stubGateway(() => response("[]"));
    const result = await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: "mock:deterministic",
      findings: [],
      observedCaseKeys: [],
      gateway,
    });
    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("returns the model's findings with its usage, asking for JSON at temperature zero", async () => {
    const { gateway, calls } = stubGateway(() =>
      response(JSON.stringify([{ category: "incorrect_final_answer", summary: "Same miss every time.", caseKeys: ["case-a"] }])),
    );
    const result = await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: "mock:deterministic",
      findings: [draft()],
      observedCaseKeys: ["case-a", "case-b"],
      gateway,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.responseFormat).toBe("json");
    expect(calls[0]?.metadata?.["purpose"]).toBe("optimization.failure-analysis");
    expect(result.findings).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(160);
    expect(result.error).toBeNull();
  });

  it("drops a finding that names a case the evidence never showed", async () => {
    const { gateway } = stubGateway(() =>
      response(
        JSON.stringify([
          { category: "incorrect_final_answer", summary: "Invented.", caseKeys: ["case-unseen"] },
          { category: "excessive_latency", summary: "Observed.", caseKeys: ["case-b"] },
        ]),
      ),
    );
    const result = await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: "mock:deterministic",
      findings: [draft()],
      observedCaseKeys: ["case-a", "case-b"],
      gateway,
    });
    expect(result.findings.map((finding) => finding.summary)).toEqual(["Observed."]);
  });

  it("reports a provider failure instead of throwing, so the loop keeps its deterministic findings", async () => {
    const { gateway } = stubGateway(() => {
      throw new LLMProviderError("rate_limited", "mock", "mock rate limit (429)", { retryable: true });
    });
    const result = await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: "mock:deterministic",
      findings: [draft()],
      observedCaseKeys: ["case-a"],
      gateway,
    });
    expect(result.findings).toEqual([]);
    expect(result.usage).toBeNull();
    expect(result.error).toContain("rate_limited");
  });

  it("asks for one analysis per pass, not one per case", async () => {
    const generate = vi.fn(async () => response("[]"));
    const gateway: LLMGateway = {
      register: () => undefined,
      getProvider: () => mockProvider,
      listProviders: () => [],
      generate,
    };
    await analyzeSemantically({
      sessionId: "s1",
      batchId: "b1",
      analyzerModel: "mock:deterministic",
      findings: [draft(), draft({ category: "excessive_latency", caseKeys: ["case-b"] })],
      observedCaseKeys: ["case-a", "case-b"],
      gateway,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
