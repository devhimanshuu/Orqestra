/**
 * LLM-assisted failure analysis.
 *
 * Deterministic rules catch objective properties (tool repetition, loop
 * iterations, latency and token ceilings, evaluator verdicts). What they cannot
 * do is read a hundred evaluator explanations and name the *pattern* in them —
 * "every wrong answer is wrong in the same way". That is what this module is
 * for, and it is deliberately fenced:
 *
 *  - it only ever sees summaries the deterministic pass already produced;
 *  - every finding it returns is labelled `confidence: "llm"` and `isLlm: true`,
 *    so it can never be read as observed fact (the hypothesis generator even
 *    downgrades its confidence to "low");
 *  - a case key it names must be one the deterministic pass saw fail. An
 *    invented case key is dropped, not stored;
 *  - it may not invent run ids, evaluator keys or trace references — those are
 *    evidence, and only the deterministic pass produces them;
 *  - a failure to call it, or to parse its answer, is a no-op: the loop keeps
 *    the deterministic findings and records why.
 *
 * Its usage is accounted separately from the agent runs it reasons about.
 */

import { getLLMGateway, type LLMGateway } from "@/modules/llm/llm.gateway";
import { LLMProviderError } from "@/modules/llm/llm.types";
import { logger } from "@/lib/logging/logger";
import {
  FAILURE_CATEGORIES,
  isFailureCategory,
  type FindingConfidence,
} from "../optimization.types";
import type { FindingDraft } from "./failure-analysis";

const analysisLogger = logger.child({ module: "optimization.llm-analysis" });

/** Cap on model-authored findings, so one prompt cannot flood a session. */
export const MAX_LLM_FINDINGS = 5;

export interface LlmAnalysisUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface LlmAnalysisInput {
  sessionId: string;
  batchId: string;
  /** The model reference the session allows; null disables the analyzer. */
  analyzerModel: string | null;
  /** Deterministic findings, already stored — the only thing the model sees. */
  findings: readonly FindingDraft[];
  /** Every case key that appeared in the deterministic evidence. */
  observedCaseKeys: readonly string[];
  gateway?: LLMGateway;
}

/**
 * Validates an untrusted model answer into findings.
 *
 * Pure and total: anything unparseable is dropped, anything out of taxonomy is
 * dropped, and any case key outside the observed set is dropped (the whole
 * finding goes with it — a claim about cases the evidence never showed is not a
 * claim about this batch).
 */
export function parseLlmFindings(
  raw: unknown,
  observedCaseKeys: readonly string[],
): FindingDraft[] {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const observed = new Set(observedCaseKeys);

  const findings: FindingDraft[] = [];
  for (const entry of parsed.slice(0, MAX_LLM_FINDINGS)) {
    const record = entry as Record<string, unknown>;
    const category = typeof record["category"] === "string" ? record["category"] : "";
    const summary = typeof record["summary"] === "string" ? record["summary"].trim() : "";
    if (!isFailureCategory(category) || summary === "") {
      continue;
    }
    const caseKeys = Array.isArray(record["caseKeys"])
      ? (record["caseKeys"] as unknown[])
          .filter((key): key is string => typeof key === "string")
          .filter((key) => observed.has(key))
      : [];
    if (caseKeys.length === 0) {
      // No observed case supports this claim, so it does not belong in a session
      // whose findings must all point at real evidence.
      continue;
    }
    const confidence: FindingConfidence = "llm";
    findings.push({
      category: category as FindingDraft["category"],
      summary,
      frequency: `${caseKeys.length} of the failing case(s)`,
      confidence,
      impact: null,
      investigation:
        typeof record["investigation"] === "string" && record["investigation"].trim() !== ""
          ? record["investigation"].trim().slice(0, 500)
          : "Treat as a lead: confirm it against the listed cases before acting on it.",
      isLlm: true,
      caseKeys: [...new Set(caseKeys)],
      runIds: [],
      evaluatorKeys: [],
      traceRefs: [],
    });
  }
  return findings;
}

function safeParse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Builds the prompt. The model is told what it may and may not claim. */
export function buildAnalysisRequest(input: {
  findings: readonly FindingDraft[];
  batchId: string;
  caseCount: number;
}): { system: string; user: string } {
  const categories = FAILURE_CATEGORIES.join(", ");
  const system = [
    "You are the failure analyst of an agent-harness optimization engine.",
    "You will see a deterministic analysis of one evaluation batch: the observed",
    "weakness categories, what the evaluators said, and which cases showed them.",
    "Your job is to name the *pattern* across those failures — the shared cause a",
    "rule could not see — and nothing else.",
    "",
    `Rules:`,
    `- "category" must be exactly one of: ${categories}.`,
    "- Only mention case keys that appear in the evidence you were given.",
    "- Do not claim a node caused a failure unless the evidence says so.",
    "- Do not propose changes; another engine turns findings into hypotheses.",
    "- Prefer no finding over a speculative one.",
    '- Respond with JSON only: [{"category":"...","summary":"...","caseKeys":["..."],"investigation":"..."}]',
  ].join("\n");

  const user = [
    `Evaluation batch ${input.batchId}: ${input.caseCount} case(s) executed.`,
    "",
    "Observed weaknesses (deterministic):",
    ...input.findings.map(
      (finding) =>
        `- ${finding.category}: ${finding.summary}${finding.frequency === null ? "" : ` (${finding.frequency})`}${finding.caseKeys.length === 0 ? "" : ` cases: ${finding.caseKeys.join(", ")}`}`,
    ),
    "",
    "Name up to 5 patterns across these failures. Every claim must point at at least one case key listed above.",
  ].join("\n");

  return { system, user };
}

/**
 * Runs the analyzer. Never throws: an analyzer that cannot answer leaves the
 * deterministic analysis untouched, and the reason is returned so the loop can
 * record it on the timeline instead of hiding it.
 */
export async function analyzeSemantically(
  input: LlmAnalysisInput,
): Promise<{ findings: FindingDraft[]; usage: LlmAnalysisUsage | null; error: string | null }> {
  if (input.analyzerModel === null || input.findings.length === 0 || input.observedCaseKeys.length === 0) {
    return { findings: [], usage: null, error: null };
  }
  const gateway = input.gateway ?? getLLMGateway();
  const prompt = buildAnalysisRequest({
    findings: input.findings,
    batchId: input.batchId,
    caseCount: input.observedCaseKeys.length,
  });

  let response;
  try {
    response = await gateway.generate(input.analyzerModel, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0,
      responseFormat: "json",
      metadata: { purpose: "optimization.failure-analysis", sessionId: input.sessionId },
    });
  } catch (error) {
    const message =
      error instanceof LLMProviderError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "the analyzer model failed";
    analysisLogger.warn("llm failure analysis skipped", { sessionId: input.sessionId, message });
    return { findings: [], usage: null, error: `Analyzer model unavailable (${message}).` };
  }

  const usage: LlmAnalysisUsage = {
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
    model: `${response.provider}:${response.model}`,
  };
  const findings = parseLlmFindings(response.content, input.observedCaseKeys);
  return { findings, usage, error: null };
}
