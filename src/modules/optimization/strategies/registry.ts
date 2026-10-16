/**
 * Strategy registry.
 *
 * A strategy answers one question: *given this hypothesis, which typed
 * operations would test it?* Three implementations exist, and they are
 * interchangeable because they all return the same thing — validated mutation
 * operations, or a refusal with a reason.
 *
 *  1. **Rule-Based** — re-runs the deterministic rule engine that produced the
 *     hypothesis and matches it by fingerprint. No model call, no cost, and the
 *     same hypothesis always yields the same operations.
 *  2. **LLM-Assisted** — asks a configured provider for operations, then treats
 *     the answer as *untrusted data*: it must parse as the mutation schema, and
 *     it still goes through the mutation engine and validator afterwards. The
 *     model can propose; it cannot write, and it cannot bypass a single rule.
 *  3. **Manual** — a developer publishes a candidate version in the builder and
 *     attaches it; that path lives in the service, not here.
 */

import { getLLMGateway, type LLMGateway } from "@/modules/llm/llm.gateway";
import { LLMProviderError } from "@/modules/llm/llm.types";
import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import { generateHypotheses } from "../hypotheses/generate";
import { hypothesisFingerprint } from "../hypotheses/fingerprint";
import {
  MUTABLE_NUMERIC_FIELDS,
  MUTATION_OPERATIONS,
  PROMPT_FIELDS,
  parseMutationOperations,
  type MutationOperation,
} from "../mutations/operations";
import type {
  FailureFindingRecord,
  ImprovementHypothesisRecord,
  OptimizationLimits,
  OptimizationObjective,
  OptimizationStrategyKind,
} from "../optimization.types";

export interface ProposalRequest {
  hypothesis: ImprovementHypothesisRecord;
  findings: readonly FailureFindingRecord[];
  /** The baseline definition: every operation must target a node in it. */
  definition: HarnessDefinition | null;
  objective: OptimizationObjective;
  evaluatorConfig: readonly EvaluatorAssignmentSnapshot[];
  limits: OptimizationLimits;
  sessionStrategy: OptimizationStrategyKind;
}

export interface ProposalUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string | null;
}

export interface ProposalOutcome {
  ok: boolean;
  operations: MutationOperation[];
  /** Why the strategy could not propose, when it could not. */
  reason: string | null;
  usage: ProposalUsage;
}

const EMPTY_USAGE: ProposalUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  model: null,
};

/**
 * Strategy 1 — reproduce the deterministic rule's operations.
 *
 * The rule engine is pure, so re-running it over the same findings and the same
 * pinned baseline definition reproduces the identical proposal list; matching on
 * fingerprint therefore recovers the operations *and* proves the hypothesis has
 * not drifted from the rule that made it.
 */
export function proposeRuleBased(request: ProposalRequest): ProposalOutcome {
  const definition = request.definition;
  if (definition === null) {
    return { ok: false, operations: [], reason: "The baseline definition could not be read.", usage: EMPTY_USAGE };
  }
  const regenerated = generateHypotheses({
    findings: request.findings,
    definition,
    objective: request.objective,
    evaluatorConfig: request.evaluatorConfig,
    origin: "RULE_BASED",
  });
  const match = regenerated.find(
    (proposal) => hypothesisFingerprint(proposal) === request.hypothesis.fingerprint,
  );
  if (match === undefined) {
    return {
      ok: false,
      operations: [],
      reason:
        "This hypothesis does not correspond to a reproducible rule for the pinned baseline, so no operations can be derived from it.",
      usage: EMPTY_USAGE,
    };
  }
  const parsed = parseMutationOperations(match.operations);
  if (!parsed.ok) {
    return {
      ok: false,
      operations: [],
      reason: `The rule produced operations that do not satisfy the mutation schema: ${parsed.issues.join("; ")}`,
      usage: EMPTY_USAGE,
    };
  }
  return { ok: true, operations: parsed.operations, reason: null, usage: EMPTY_USAGE };
}

/** The schema the model is handed, generated from the same source of truth. */
export function describeMutationSchema(): string {
  const fields = Object.entries(PROMPT_FIELDS)
    .map(([type, list]) => `    ${type}: ${list.join(", ")}`)
    .join("\n");
  const numbers = Object.entries(MUTABLE_NUMERIC_FIELDS)
    .map(
      ([type, entries]) =>
        `    ${type}: ${entries
          .map((entry) => `${entry.key} [${entry.min}..${entry.max}]`)
          .join(", ")}`,
    )
    .join("\n");
  return [
    `Allowed operations: ${MUTATION_OPERATIONS.join(", ")}.`,
    "Prompt writes are allowed on:",
    fields,
    "Numeric knobs are allowed on:",
    numbers,
    "Rules: never invent node ids; never remove start/end/tool/human_approval nodes; prefer the single smallest change that addresses the failure; one to three operations maximum.",
    'Respond with JSON only: {"operations": [ { "op": "...", "reason": "..." } ]}',
  ].join("\n");
}

/** A compact, evidence-carrying view of the harness for the prompt. */
export function describeDefinition(definition: HarnessDefinition): string {
  const nodes = definition.nodes
    .map((node) => {
      const config = node.config as Record<string, unknown>;
      const text = Object.entries(config)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => `${key}="${String(value).slice(0, 240)}"`)
        .join(" ");
      return `  ${node.id} [${node.type}] ${node.label}${text === "" ? "" : ` ${text}`}`;
    })
    .join("\n");
  const edges = definition.edges
    .map((edge) => `  ${edge.source}${edge.sourceHandle === undefined ? "" : `:${edge.sourceHandle}`} → ${edge.target}`)
    .join("\n");
  return `Nodes:\n${nodes}\nEdges:\n${edges}\nEntry: ${definition.entryNode}; Exits: ${definition.exitNodes.join(", ")}`;
}

function describeFindings(findings: readonly FailureFindingRecord[]): string {
  return findings
    .map(
      (finding) =>
        `- ${finding.category}: ${finding.summary}${finding.frequency === null ? "" : ` (${finding.frequency})`}`,
    )
    .join("\n");
}

export function buildAnalysisPrompt(request: ProposalRequest): { system: string; user: string } {
  const system = [
    "You are an optimization analyst for an agent-harness platform.",
    "You propose the smallest change that would test a stated hypothesis about a harness graph.",
    "You never invent node ids, tools, or evidence, and you never propose changing tool permissions, providers or credentials.",
    describeMutationSchema(),
  ].join("\n\n");

  const user = [
    `Hypothesis: ${request.hypothesis.title}`,
    `Claim: ${request.hypothesis.hypothesis}`,
    `Proposed change (in words): ${request.hypothesis.proposedChange}`,
    `Targeted failure category: ${request.hypothesis.category}`,
    "",
    "Evidence:",
    describeFindings(request.findings),
    "",
    `Objective: ${request.objective.primary.direction} ${request.objective.primary.metric} (min improvement ${request.objective.minImprovementPct}).`,
    "",
    "Baseline harness:",
    request.definition === null ? "(unavailable)" : describeDefinition(request.definition),
  ].join("\n");

  return { system, user };
}

/**
 * Strategy 2 — ask a model, then distrust it.
 *
 * The response is parsed as mutation operations before it is returned, so a
 * hallucinated node id, an invented operation, or a smuggled-out-of-range value
 * stops here. Everything that survives still passes the mutation engine and the
 * graph validator.
 */
export async function proposeLlmAssisted(
  request: ProposalRequest,
  gateway: LLMGateway = getLLMGateway(),
): Promise<ProposalOutcome> {
  const model = request.limits.analyzerModel;
  if (model === null) {
    return {
      ok: false,
      operations: [],
      reason:
        "No analyzer model is configured for this session, so no model-assisted proposal can be made.",
      usage: EMPTY_USAGE,
    };
  }
  const prompt = buildAnalysisPrompt(request);
  let response;
  try {
    response = await gateway.generate(model, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0,
      responseFormat: "json",
      metadata: { purpose: "optimization.hypothesis", hypothesisId: request.hypothesis.id },
    });
  } catch (error) {
    const message =
      error instanceof LLMProviderError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "the analyzer model failed";
    return { ok: false, operations: [], reason: `The analyzer model could not be called (${message}).`, usage: EMPTY_USAGE };
  }

  const usage: ProposalUsage = {
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
    model: `${response.provider}:${response.model}`,
  };

  const parsedJson = safeJson(response.content);
  if (parsedJson === null) {
    return {
      ok: false,
      operations: [],
      reason: "The analyzer model did not return parseable JSON.",
      usage,
    };
  }
  const operationsValue =
    parsedJson !== null && typeof parsedJson === "object" && !Array.isArray(parsedJson)
      ? (parsedJson as Record<string, unknown>)["operations"]
      : parsedJson;
  const parsed = parseMutationOperations(operationsValue);
  if (!parsed.ok) {
    return {
      ok: false,
      operations: [],
      reason: `The analyzer model proposed operations that do not satisfy the mutation schema: ${parsed.issues.join("; ")}`,
      usage,
    };
  }
  if (parsed.operations.length === 0) {
    return { ok: false, operations: [], reason: "The analyzer model proposed no operations.", usage };
  }
  return { ok: true, operations: parsed.operations, reason: null, usage };
}

function safeJson(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim()
    : trimmed;
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  const candidate =
    firstBrace >= 0 && lastBrace > firstBrace ? withoutFence.slice(firstBrace, lastBrace + 1) : withoutFence;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

/**
 * The strategy the session asked for, with a rule-based fallback that keeps a
 * bounded loop making progress when the analyzer is unavailable: an LLM session
 * that cannot reach its model still gets deterministic proposals.
 */
export async function proposeForHypothesis(
  request: ProposalRequest,
  gateway?: LLMGateway,
): Promise<ProposalOutcome> {
  const wantsLlm =
    request.sessionStrategy === "LLM_ASSISTED" || request.hypothesis.origin === "LLM_ASSISTED";
  if (!wantsLlm) {
    return proposeRuleBased(request);
  }

  const llm = await proposeLlmAssisted(request, gateway ?? getLLMGateway());
  if (llm.ok) {
    return llm;
  }
  const fallback = proposeRuleBased(request);
  if (fallback.ok) {
    return {
      ...fallback,
      usage: llm.usage,
      reason: null,
    };
  }
  return llm;
}
