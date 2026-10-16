/**
 * LLM-assisted hypothesis generation (the missing half of Strategy 2).
 *
 * Until now an "LLM_ASSISTED" session stamped rule-generated hypotheses with an
 * LLM origin without ever asking a model — the operations were model-proposed
 * later, but the hypotheses themselves always came from rules. This module
 * closes that gap and is fenced the same way as the LLM failure-analysis pass:
 *
 *  - the model only ever sees the deterministic findings, the pinned baseline
 *    definition and the objective;
 *  - every hypothesis it returns must name a category from the taxonomy and at
 *    least one *real* finding id — claims about findings that do not exist are
 *    dropped, not stored;
 *  - confidence is forced to "low" (a model shaped the claim, nobody observed
 *    it), and origin is recorded as LLM_ASSISTED so history can attribute it;
 *  - operations are optional here: when present they must parse through
 *    `parseMutationOperations`, so a hallucinated node id is dropped with the
 *    hypothesis it came with;
 *  - a failure to call it, or to parse its answer, is a no-op: the loop keeps
 *    the rule-based proposals and records why.
 *
 * Rule-based generation still runs for LLM sessions (it is the fallback), so a
 * model that is unavailable leaves the session fully functional.
 */

import { getLLMGateway, type LLMGateway } from "@/modules/llm/llm.gateway";
import { LLMProviderError } from "@/modules/llm/llm.types";
import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import { logger } from "@/lib/logging/logger";
import {
  FAILURE_CATEGORIES,
  isFailureCategory,
  type FailureFindingRecord,
  type OptimizationObjective,
  type ProposedHypothesis,
} from "../optimization.types";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import { parseMutationOperations } from "../mutations/operations";
import { describeDefinition, describeMutationSchema } from "../strategies/registry";

const hypothesisLogger = logger.child({ module: "optimization.llm-hypotheses" });

/** Cap on model-authored hypotheses, so one prompt cannot flood a session. */
export const MAX_LLM_HYPOTHESES = 4;

export interface LlmHypothesisUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface LlmHypothesisInput {
  sessionId: string;
  /** The model reference the session allows; null disables the generator. */
  analyzerModel: string | null;
  /** Deterministic findings — the only thing the model sees. */
  findings: readonly FailureFindingRecord[];
  /** The pinned baseline: hypotheses may only target this graph. */
  definition: HarnessDefinition | null;
  objective: OptimizationObjective;
  evaluatorConfig: readonly EvaluatorAssignmentSnapshot[];
  gateway?: LLMGateway;
}

/**
 * Validates an untrusted model answer into hypotheses.
 *
 * Pure and total: anything unparseable is dropped, anything out of taxonomy is
 * dropped, any finding id outside the stored set is dropped, and a hypothesis
 * left without a single real finding id is dropped with it — a claim about
 * findings the analysis never produced is not a claim about this session.
 */
export function parseLlmHypotheses(
  raw: unknown,
  findings: readonly FailureFindingRecord[],
  objective: OptimizationObjective,
): ProposedHypothesis[] {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { hypotheses?: unknown }).hypotheses)
      ? ((parsed as { hypotheses: unknown[] }).hypotheses)
      : null;
  if (entries === null) {
    return [];
  }

  const knownFindingIds = new Set(findings.map((finding) => finding.id));
  const metricKeys = [objective.primary.metric, ...objective.secondary.map((spec) => spec.metric)];
  const hypotheses: ProposedHypothesis[] = [];

  for (const entry of entries.slice(0, MAX_LLM_HYPOTHESES)) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const category = typeof record["category"] === "string" ? record["category"] : "";
    const title = typeof record["title"] === "string" ? record["title"].trim() : "";
    const hypothesis = typeof record["hypothesis"] === "string" ? record["hypothesis"].trim() : "";
    const proposedChange =
      typeof record["proposedChange"] === "string" ? record["proposedChange"].trim() : "";
    const expectedOutcome =
      typeof record["expectedOutcome"] === "string" ? record["expectedOutcome"].trim() : "";

    if (!isFailureCategory(category) || title === "" || hypothesis === "" || proposedChange === "") {
      continue;
    }

    // Only findings the deterministic pass actually stored may be referenced.
    const findingIds = Array.isArray(record["findingIds"])
      ? [...new Set((record["findingIds"] as unknown[]).filter(
          (id): id is string => typeof id === "string" && knownFindingIds.has(id),
        ))]
      : [];
    if (findingIds.length === 0) {
      continue;
    }

    // Operations are optional; when offered they must fully satisfy the
    // mutation schema — one bad field drops the whole hypothesis.
    let operations: unknown[] = [];
    if (record["operations"] !== undefined) {
      const parsedOps = parseMutationOperations(record["operations"]);
      if (!parsedOps.ok) {
        continue;
      }
      operations = parsedOps.operations;
    }

    hypotheses.push({
      category,
      title: title.slice(0, 200),
      observation: findings.find((finding) => finding.id === findingIds[0])?.summary ?? hypothesis.slice(0, 500),
      hypothesis: hypothesis.slice(0, 1_000),
      proposedChange: proposedChange.slice(0, 1_000),
      expectedOutcome: expectedOutcome === "" ? "The targeted metric improves on the failing cases." : expectedOutcome.slice(0, 500),
      tradeoff:
        typeof record["tradeoff"] === "string" && record["tradeoff"].trim() !== ""
          ? record["tradeoff"].trim().slice(0, 500)
          : null,
      metricKeys,
      // A model shaped this claim; nobody observed it. Never higher than low.
      confidence: "low",
      requiresReview: operations.some(
        (operation) => (operation as { op: string }).op !== "set_prompt_instruction",
      ),
      origin: "LLM_ASSISTED",
      findingIds,
      operations,
      acceptanceCriteria: {
        primaryMetric: objective.primary.metric,
        direction: objective.primary.direction,
        minImprovementPct: objective.minImprovementPct,
      },
    });
  }
  return hypotheses;
}

function safeParse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const objectStart = trimmed.indexOf("{");
  // Accept either a bare array or a {"hypotheses": [...]} envelope.
  if (start !== -1) {
    const end = trimmed.lastIndexOf("]");
    if (end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (objectStart !== -1) {
    const end = trimmed.lastIndexOf("}");
    if (end <= objectStart) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(objectStart, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Builds the prompt. The model is told what it may and may not claim. */
export function buildHypothesisRequest(input: {
  findings: readonly FailureFindingRecord[];
  definition: HarnessDefinition;
  objective: OptimizationObjective;
  evaluatorConfig: readonly EvaluatorAssignmentSnapshot[];
}): { system: string; user: string } {
  const categories = FAILURE_CATEGORIES.join(", ");
  const system = [
    "You are the hypothesis engine of an agent-harness optimization engine.",
    "You will see the deterministic failure analysis of one evaluation batch and the",
    "pinned baseline harness graph. Your job is to propose testable hypotheses: each",
    "names the smallest change expected to move the objective, and nothing else.",
    "",
    "Rules:",
    `- "category" must be exactly one of: ${categories}.`,
    '- Every hypothesis must list at least one "findingId" from the ids given below.',
    "- Never invent node ids, edge ids, tools, findings or evidence.",
    "- Never propose changing tool permissions, providers or credentials.",
    "- Prefer the single smallest change; graph edits are a last resort.",
    "- Prefer no hypothesis over a speculative one.",
    describeMutationSchema(),
    '- Respond with JSON only: {"hypotheses": [{"category":"...","title":"...","hypothesis":"...","proposedChange":"...","expectedOutcome":"...","tradeoff":"...","findingIds":["..."],"operations":[{"op":"...","nodeId":"...","reason":"..."}]}]}',
    'Return "operations" only when you can name the exact target; a hypothesis without operations is still useful.',
  ].join("\n");

  const user = [
    "Findings (deterministic, with ids):",
    ...input.findings.map(
      (finding) =>
        `- id=${finding.id} ${finding.category}: ${finding.summary}${finding.frequency === null ? "" : ` (${finding.frequency})`}${finding.confidence === "llm" ? " [llm-shaped lead]" : ""}`,
    ),
    "",
    `Objective: ${input.objective.primary.direction} ${input.objective.primary.metric} (min improvement ${input.objective.minImprovementPct}).`,
    "",
    "Pinned evaluator config:",
    input.evaluatorConfig.length === 0
      ? "(none)"
      : input.evaluatorConfig.map((entry) => `- ${entry.key} (${entry.kind}, weight ${entry.weight})`).join("\n"),
    "",
    "Baseline harness:",
    describeDefinition(input.definition),
    "",
    `Propose up to ${MAX_LLM_HYPOTHESES} hypotheses that answer these findings.`,
  ].join("\n");

  return { system, user };
}

/**
 * Runs the generator. Never throws: a model that cannot answer leaves the
 * rule-based proposals untouched, and the reason is returned so the loop can
 * record it on the timeline instead of hiding it.
 */
export async function generateLlmHypotheses(
  input: LlmHypothesisInput,
): Promise<{ hypotheses: ProposedHypothesis[]; usage: LlmHypothesisUsage | null; error: string | null }> {
  if (input.analyzerModel === null || input.findings.length === 0 || input.definition === null) {
    return { hypotheses: [], usage: null, error: null };
  }
  const gateway = input.gateway ?? getLLMGateway();
  const prompt = buildHypothesisRequest({
    findings: input.findings,
    definition: input.definition,
    objective: input.objective,
    evaluatorConfig: input.evaluatorConfig,
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
      metadata: { purpose: "optimization.hypothesis-generation", sessionId: input.sessionId },
    });
  } catch (error) {
    const message =
      error instanceof LLMProviderError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "the analyzer model failed";
    hypothesisLogger.warn("llm hypothesis generation skipped", { sessionId: input.sessionId, message });
    return { hypotheses: [], usage: null, error: `Analyzer model unavailable (${message}).` };
  }

  const usage: LlmHypothesisUsage = {
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
    model: `${response.provider}:${response.model}`,
  };
  const hypotheses = parseLlmHypotheses(response.content, input.findings, input.objective);
  return { hypotheses, usage, error: null };
}
