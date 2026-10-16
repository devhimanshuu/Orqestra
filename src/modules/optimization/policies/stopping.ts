/**
 * Stopping conditions.
 *
 * The loop is bounded by construction: every ceiling is checked *before* an
 * iteration starts, so no pass can overshoot a budget it was given. Pure and
 * ordered — the first condition that fires names the stop reason, and every
 * contributing condition is returned as a note so a stop can always be
 * explained.
 *
 * Ordering matters and is deliberate: cancellation and infrastructure failures
 * outrank budgets, budgets outrank progress heuristics.
 */

import type { StoppingInput, StoppingVerdict } from "../optimization.types";

/** Runs one candidate evaluation is expected to create, for budget pre-checks. */
export function projectedRuns(plannedCases: number, perIterationCandidates: number): number {
  return Math.max(0, plannedCases) * Math.max(1, perIterationCandidates);
}

export function evaluateStopping(input: StoppingInput): StoppingVerdict {
  const notes: string[] = [];

  if (input.cancelRequested) {
    return { stop: true, reason: "cancelled", notes: ["Cancellation was requested."] };
  }

  if (input.iterationsCompleted >= input.limits.maxIterations) {
    return {
      stop: true,
      reason: "max_iterations",
      notes: [`Reached the configured iteration limit (${input.limits.maxIterations}).`],
    };
  }

  if (input.candidateCount >= input.limits.maxCandidates) {
    return {
      stop: true,
      reason: "max_candidates",
      notes: [`Reached the configured candidate limit (${input.limits.maxCandidates}).`],
    };
  }

  if (input.runCount >= input.limits.maxRuns) {
    return {
      stop: true,
      reason: "max_runs",
      notes: [`Reached the configured run budget (${input.limits.maxRuns} runs).`],
    };
  }

  if (input.limits.maxTotalTokens !== null && input.tokenUsage >= input.limits.maxTotalTokens) {
    return {
      stop: true,
      reason: "token_budget",
      notes: [
        `Token budget exhausted (${input.tokenUsage} of ${input.limits.maxTotalTokens} tokens).`,
      ],
    };
  }

  if (input.limits.maxCostUsd !== null && input.estimatedCostUsd >= input.limits.maxCostUsd) {
    return {
      stop: true,
      reason: "cost_budget",
      notes: [
        `Cost budget exhausted ($${input.estimatedCostUsd.toFixed(4)} of $${input.limits.maxCostUsd}).`,
      ],
    };
  }

  if (input.limits.maxElapsedMs !== null && input.elapsedMs >= input.limits.maxElapsedMs) {
    return {
      stop: true,
      reason: "time_budget",
      notes: [`Elapsed ${Math.round(input.elapsedMs / 1000)}s of the ${Math.round(input.limits.maxElapsedMs / 1000)}s wall-clock budget.`],
    };
  }

  if (input.consecutiveInvalid >= input.limits.maxConsecutiveInvalid) {
    return {
      stop: true,
      reason: "consecutive_invalid",
      notes: [
        `${input.consecutiveInvalid} candidates in a row were rejected before evaluation — the strategy is not producing runnable changes.`,
      ],
    };
  }

  if (input.remainingHypotheses === 0) {
    return {
      stop: true,
      reason: "no_hypotheses",
      notes: ["No untried hypotheses remain for the findings that were found."],
    };
  }

  if (input.stallIterations >= input.limits.stallIterations) {
    return {
      stop: true,
      reason: "no_improvement",
      notes: [
        `${input.stallIterations} iteration(s) passed without an accepted improvement (limit ${input.limits.stallIterations}).`,
      ],
    };
  }

  if (notes.length > 0) {
    return { stop: false, reason: null, notes };
  }
  return { stop: false, reason: null, notes: [] };
}

/**
 * Whether another candidate evaluation fits inside the remaining run budget.
 * Checked per candidate, so the loop cannot start an evaluation it cannot finish
 * paying for.
 */
export function fitsRunBudget(input: {
  runCount: number;
  maxRuns: number;
  plannedCases: number;
}): boolean {
  return input.runCount + input.plannedCases <= input.maxRuns;
}
