/**
 * Failure analysis engine.
 *
 * Reads what a real evaluation actually produced — case statuses, run
 * observables, evaluator verdicts, step-level failures — and reduces it to a
 * small set of *clustered* weaknesses. Everything here is deterministic and
 * explainable: the same batch always yields the same findings, and every finding
 * carries the case keys, run ids and evaluator keys it was derived from.
 *
 * Two rules the engine will not break:
 *
 *  - **No invented evidence.** A finding only exists if at least one real case
 *    exhibited it, and its `traceRefs` are row pointers, never prose.
 *  - **No blame without data.** The engine never claims "node X caused this".
 *    It reports what the runtime recorded (a step failed, a loop ran 9 times, a
 *    judge scored 0.2) and leaves causal attribution to the hypothesis step.
 */

import { DEFAULT_ANALYSIS_THRESHOLDS } from "../optimization.types";
import type {
  AnalysisInput,
  AnalysisThresholds,
  FailureCategory,
  FindingConfidence,
  SourceCaseFacts,
  TraceRef,
} from "../optimization.types";

/** A finding before persistence assigns it an id and a session. */
export interface FindingDraft {
  category: FailureCategory;
  summary: string;
  frequency: string | null;
  confidence: FindingConfidence;
  impact: string | null;
  investigation: string | null;
  isLlm: boolean;
  caseKeys: string[];
  runIds: string[];
  evaluatorKeys: string[];
  traceRefs: TraceRef[];
}

/** Why a category matters, in the product's own words. */
const IMPACT: Record<FailureCategory, string> = {
  incorrect_final_answer:
    "The agent completes but its answer is wrong — the harness's quality ceiling.",
  missing_required_information:
    "Answers are incomplete: required fields or details never reach the output.",
  invalid_structured_output:
    "Machine-readable output cannot be parsed, so downstream steps and consumers fail.",
  missing_tool_usage:
    "A required tool is never called, so the agent answers from memory instead of evidence.",
  inappropriate_tool_usage:
    "The wrong tool is called for the task, wasting budget and producing unusable evidence.",
  excessive_tool_calls:
    "Tool calls per case are far above the norm — cost and latency without added value.",
  repeated_tool_calls:
    "The same tool is invoked repeatedly for one case, which usually means an unresolved state.",
  tool_error_recovery_failure:
    "A tool failure ends the case instead of being handled.",
  excessive_loop_iterations:
    "The loop runs far more than needed, inflating cost and latency.",
  premature_termination:
    "The run ends before producing a complete result.",
  termination_limit_exceeded:
    "The run hits an execution limit instead of terminating on its own terms.",
  excessive_latency:
    "Cases take far longer than the batch's own norm, which caps practical throughput.",
  excessive_token_usage:
    "Token usage per case is far above the norm, which caps practical cost.",
  harness_policy_violation:
    "The declared harness policy is not respected at runtime.",
  inconsistent_trials:
    "Repeated trials disagree, so the same input does not produce the same behavior.",
};

const INVESTIGATION: Record<FailureCategory, string> = {
  incorrect_final_answer:
    "Read the failing case traces and check whether the instructions state the expected output, or whether the model lacked the evidence it needed.",
  missing_required_information:
    "Check the prompt/instructions for explicit output requirements (fields, sections, citations) and whether they are stated per node.",
  invalid_structured_output:
    "Add or tighten explicit output requirements, and confirm a validation step exists before the output is consumed.",
  missing_tool_usage:
    "Inspect the tool-selection instructions and whether the retrieval step is reachable for these inputs.",
  inappropriate_tool_usage:
    "Review the router/condition logic that selects the tool for these inputs.",
  excessive_tool_calls:
    "Check whether the loop termination condition can be satisfied, and whether tool results are fed back into state.",
  repeated_tool_calls:
    "Inspect whether a failed tool result leaves state unchanged, causing an unconditional retry.",
  tool_error_recovery_failure:
    "Look for error-handling instructions and whether the tool step has a bounded retry/fallback path.",
  excessive_loop_iterations:
    "Inspect the explicit loop's termination criteria and the condition that exits it.",
  premature_termination:
    "Read the steps that precede the stop and check whether a branch can reach the end node early.",
  termination_limit_exceeded:
    "Raise the relevant execution limit only if the work itself is justified — otherwise tighten the termination criteria.",
  excessive_latency:
    "Find which node dominates the latency (steps are ordered and timed) and whether the path can be shortened.",
  excessive_token_usage:
    "Check system prompts and context injection (memory/context nodes) for content that is re-sent every call.",
  harness_policy_violation:
    "Read the compliance verdict's evidence: which declared behavior was not observed.",
  inconsistent_trials:
    "Compare the trials' step sequences to find the branch that diverges.",
};

interface CaseHit {
  category: FailureCategory;
  caseKey: string;
  runId: string | null;
  evaluatorKey: string | null;
  stepIndexes: number[];
  note: string;
  /** Deterministic evidence → high; derived threshold → medium; heuristic → low. */
  confidence: FindingConfidence;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Maps a runtime error code to a weakness. Exported because the mapping is a
 * product decision worth testing on its own.
 *
 * Unknown codes are never guessed into a specific category: they fall back to
 * `premature_termination`, which says exactly what is known (the run stopped
 * early) and nothing more.
 */
export function classifyRunFailure(code: string | null, message: string | null): FailureCategory {
  const haystack = `${code ?? ""} ${message ?? ""}`.toUpperCase();
  if (haystack.includes("TOOL")) {
    return "tool_error_recovery_failure";
  }
  if (haystack.includes("TIMEOUT") || haystack.includes("TIMED_OUT")) {
    return "excessive_latency";
  }
  if (
    haystack.includes("LIMIT") ||
    haystack.includes("MAX_STEPS") ||
    haystack.includes("MAX_ITERATION") ||
    haystack.includes("BUDGET")
  ) {
    return "termination_limit_exceeded";
  }
  if (haystack.includes("CANCEL")) {
    // Cancellation is an operator decision, not a harness weakness.
    return "premature_termination";
  }
  return "premature_termination";
}

/** Maps a failed evaluator verdict to a weakness, using the case's own shape. */
export function classifyEvaluatorFailure(input: {
  kind: string;
  explanation: string;
  toolCalls: number;
  toolsInvoked: readonly string[];
  thresholds: AnalysisThresholds;
}): FailureCategory {
  switch (input.kind) {
    case "json_schema":
      return "invalid_structured_output";
    case "harness_compliance":
      return "harness_policy_violation";
    case "tool_usage":
      if (input.toolsInvoked.length === 0) {
        return "missing_tool_usage";
      }
      if (input.toolCalls > input.thresholds.toolCallsPerCase) {
        return "excessive_tool_calls";
      }
      return "inappropriate_tool_usage";
    default: {
      const text = input.explanation.toLowerCase();
      if (text.includes("missing") || text.includes("empty") || text.includes("no answer")) {
        return "missing_required_information";
      }
      return "incorrect_final_answer";
    }
  }
}

/** Per-case structural checks, independent of any evaluator's verdict. */
function structuralHits(
  facts: SourceCaseFacts,
  thresholds: AnalysisThresholds,
  latencyCeilingMs: number,
): CaseHit[] {
  const hits: CaseHit[] = [];

  // Repeated identical tool invocations inside one case.
  const counts = new Map<string, number>();
  for (const toolId of facts.toolsInvoked) {
    counts.set(toolId, (counts.get(toolId) ?? 0) + 1);
  }
  for (const [toolId, count] of counts) {
    if (count >= thresholds.repeatedToolCalls) {
      hits.push({
        category: "repeated_tool_calls",
        caseKey: facts.caseKey,
        runId: facts.runId,
        evaluatorKey: null,
        stepIndexes: [],
        note: `tool "${toolId}" invoked ${count}× in one case`,
        confidence: "medium",
      });
    }
  }

  if (facts.toolCalls > thresholds.toolCallsPerCase && counts.size > 0) {
    hits.push({
      category: "excessive_tool_calls",
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [],
      note: `${facts.toolCalls} tool calls (ceiling ${thresholds.toolCallsPerCase})`,
      confidence: "medium",
    });
  }

  if (facts.loopIterations !== null && facts.loopIterations > thresholds.loopIterations) {
    hits.push({
      category: "excessive_loop_iterations",
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [],
      note: `loop ran ${facts.loopIterations} iterations (ceiling ${thresholds.loopIterations})`,
      confidence: "medium",
    });
  } else if (facts.stepCount > thresholds.stepsPerCase) {
    hits.push({
      category: "excessive_loop_iterations",
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [],
      note: `${facts.stepCount} node executions (ceiling ${thresholds.stepsPerCase})`,
      confidence: "low",
    });
  }

  if (facts.latencyMs !== null && facts.latencyMs > latencyCeilingMs) {
    hits.push({
      category: "excessive_latency",
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [],
      note: `${Math.round(facts.latencyMs)}ms against a ${Math.round(latencyCeilingMs)}ms ceiling`,
      confidence: "medium",
    });
  }

  if (facts.totalTokens !== null && facts.totalTokens > thresholds.tokensPerCase) {
    hits.push({
      category: "excessive_token_usage",
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [],
      note: `${facts.totalTokens} tokens (ceiling ${thresholds.tokensPerCase})`,
      confidence: "medium",
    });
  }

  // Step-level failures the runtime recorded: the most direct evidence there is.
  for (const step of facts.failedSteps) {
    const category = classifyRunFailure(step.code, step.message);
    hits.push({
      category,
      caseKey: facts.caseKey,
      runId: facts.runId,
      evaluatorKey: null,
      stepIndexes: [step.index],
      note: `step ${step.index} (${step.nodeType}) failed: ${step.code ?? "unknown"}${step.message === null ? "" : ` — ${step.message}`}`,
      confidence: "high",
    });
  }

  return hits;
}

/** The whole analysis: one pass over the batch, clustered by category. */
export function analyzeFailures(input: AnalysisInput): FindingDraft[] {
  const thresholds: AnalysisThresholds = { ...DEFAULT_ANALYSIS_THRESHOLDS, ...input.thresholds };
  const cases = input.cases;
  if (cases.length === 0) {
    return [];
  }

  const latencies = cases
    .map((entry) => entry.latencyMs)
    .filter((value): value is number => value !== null && value > 0);
  const latencyMedian = median(latencies);
  const latencyCeilingMs =
    latencyMedian === null
      ? thresholds.latencyFloorMs
      : Math.max(thresholds.latencyFloorMs, latencyMedian * thresholds.latencyMedianFactor);

  const hits: CaseHit[] = [];

  for (const facts of cases) {
    hits.push(...structuralHits(facts, thresholds, latencyCeilingMs));

    // A run that failed outright: classified from the runtime's own error.
    if (facts.status === "FAILED" && facts.runId !== null && facts.error !== null) {
      const code = typeof facts.error.code === "string" ? facts.error.code : null;
      const message = typeof facts.error.message === "string" ? facts.error.message : null;
      const category = classifyRunFailure(code, message);
      hits.push({
        category,
        caseKey: facts.caseKey,
        runId: facts.runId,
        evaluatorKey: null,
        stepIndexes: [],
        note: `case failed: ${code ?? "unknown"}${message === null ? "" : ` — ${message}`}`,
        confidence: "high",
      });
      continue;
    }

    // A run that succeeded but was judged wrong: the evaluator's verdict decides.
    for (const result of facts.results) {
      if (result.passed !== false) {
        continue;
      }
      const category = classifyEvaluatorFailure({
        kind: result.kind,
        explanation: result.explanation,
        toolCalls: facts.toolCalls,
        toolsInvoked: facts.toolsInvoked,
        thresholds,
      });
      hits.push({
        category,
        caseKey: facts.caseKey,
        runId: facts.runId,
        evaluatorKey: result.evaluatorKey,
        stepIndexes: [],
        note:
          `${result.evaluatorName} scored ${result.normalizedScore === null ? "no score" : result.normalizedScore.toFixed(2)}` +
          (result.explanation === "" ? "" : ` — ${result.explanation.slice(0, 200)}`),
        confidence: "high",
      });
    }

    // Attempts > 1 that still completed: the same input behaved differently.
    if (facts.attempt > 1 && facts.status === "COMPLETED") {
      hits.push({
        category: "inconsistent_trials",
        caseKey: facts.caseKey,
        runId: facts.runId,
        evaluatorKey: null,
        stepIndexes: [],
        note: `case needed ${facts.attempt} attempts before completing`,
        confidence: "low",
      });
    }
  }

  // Cluster by category, preserving evidence and using the strongest confidence.
  const byCategory = new Map<FailureCategory, CaseHit[]>();
  for (const hit of hits) {
    const bucket = byCategory.get(hit.category);
    if (bucket === undefined) {
      byCategory.set(hit.category, [hit]);
    } else {
      bucket.push(hit);
    }
  }

  const drafts: FindingDraft[] = [];
  for (const [category, bucket] of byCategory) {
    const caseKeys = [...new Set(bucket.map((hit) => hit.caseKey))];
    const runIds = [
      ...new Set(bucket.map((hit) => hit.runId).filter((id): id is string => id !== null)),
    ];
    const evaluatorKeys = [
      ...new Set(bucket.map((hit) => hit.evaluatorKey).filter((key): key is string => key !== null)),
    ];
    const confidence: FindingConfidence = bucket.some((hit) => hit.confidence === "high")
      ? "high"
      : bucket.some((hit) => hit.confidence === "medium")
        ? "medium"
        : "low";

    const rate = caseKeys.length / cases.length;
    drafts.push({
      category,
      summary: summarize(category, bucket, cases.length),
      frequency: `${caseKeys.length}/${cases.length} cases (${Math.round(rate * 100)}%)`,
      confidence,
      impact: IMPACT[category],
      investigation: INVESTIGATION[category],
      isLlm: false,
      caseKeys,
      runIds,
      evaluatorKeys,
      traceRefs: bucket.slice(0, 10).map((hit) => ({
        caseKey: hit.caseKey,
        runId: hit.runId,
        stepIndexes: hit.stepIndexes,
        note: hit.note,
      })),
    });
  }

  // Most frequent first, then by category for a stable order.
  return drafts.sort((a, b) => {
    const aCount = a.caseKeys.length;
    const bCount = b.caseKeys.length;
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    return a.category.localeCompare(b.category);
  });
}

function summarize(category: FailureCategory, bucket: CaseHit[], total: number): string {
  const caseCount = new Set(bucket.map((hit) => hit.caseKey)).size;
  const example = bucket[0];
  const detail = example === undefined ? "" : ` Latest: ${example.note}.`;
  return `${LABELS[category]} in ${caseCount} of ${total} cases.${detail}`;
}

const LABELS: Record<FailureCategory, string> = {
  incorrect_final_answer: "Incorrect final answer",
  missing_required_information: "Missing required information",
  invalid_structured_output: "Invalid structured output",
  missing_tool_usage: "Required tool never used",
  inappropriate_tool_usage: "Inappropriate tool usage",
  excessive_tool_calls: "Excessive tool calls",
  repeated_tool_calls: "Repeated tool calls",
  tool_error_recovery_failure: "No recovery from a tool error",
  excessive_loop_iterations: "Excessive loop iterations",
  premature_termination: "Premature termination",
  termination_limit_exceeded: "Execution limit reached",
  excessive_latency: "Excessive latency",
  excessive_token_usage: "Excessive token usage",
  harness_policy_violation: "Harness policy violation",
  inconsistent_trials: "Inconsistent repeated trials",
};

export function categoryLabel(category: FailureCategory): string {
  return LABELS[category];
}

export { IMPACT as CATEGORY_IMPACT, INVESTIGATION as CATEGORY_INVESTIGATION };
