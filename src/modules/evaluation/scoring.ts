/**
 * Scoring.
 *
 * One job: turn a set of evaluator results into a single weighted score —
 * *honestly*. The rules below are the contract, and they exist because the
 * tempting shortcuts are all wrong:
 *
 *  - a missing score is never a zero. `REQUIRE_ALL` marks the aggregate
 *    INCOMPLETE instead of averaging over what happened to arrive;
 *  - `IGNORE_MISSING` re-normalises over the evaluators that scored, which is
 *    only correct because it is chosen explicitly, per batch, and recorded;
 *  - an evaluator that crashed is reported as errored, and if nothing scored at
 *    all the aggregate is FAILED rather than `null` in disguise;
 *  - all weights zero is not an error — it means "no weighting configured", and
 *    the evaluators are weighted equally. That decision is stated in the
 *    aggregate's explanation so a reader never has to guess;
 *  - individual results are always preserved: `contributions` carries every
 *    weighted evaluator, scored or not.
 *
 * Weights are normalised to sum to 1 before aggregation, so the resulting score
 * is always in [0, 1] and comparable across batches with different weight sets.
 */

import type {
  AggregateScore,
  EvaluationResultRecord,
  ScoringPolicy,
} from "./evaluation.types";

export const DEFAULT_SCORING_POLICY: ScoringPolicy = "REQUIRE_ALL";

/** Throws a descriptive error when an evaluator reported an impossible score. */
export function normalizeScoreValue(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    throw new Error(`Invalid score ${score}/${maxScore}: scores must be finite with a positive maximum.`);
  }
  if (score < 0) {
    throw new Error(`Invalid score ${score}: scores cannot be negative.`);
  }
  if (score > maxScore + 1e-9) {
    throw new Error(`Invalid score ${score}/${maxScore}: the score exceeds its maximum.`);
  }
  return Math.min(1, Math.max(0, score / maxScore));
}

export interface WeightedEvaluator {
  evaluatorKey: string;
  weight: number;
}

export interface WeightNormalization {
  weights: Map<string, number>;
  /** True when no evaluator carried weight and equal weights were applied. */
  equalWeightsApplied: boolean;
  total: number;
}

/**
 * Normalises raw weights so they sum to 1. Zero total means "unweighted", which
 * becomes equal weighting (documented, not silent).
 */
export function normalizeWeights(assignments: readonly WeightedEvaluator[]): WeightNormalization {
  const weights = new Map<string, number>();
  let total = 0;
  for (const assignment of assignments) {
    const weight = Number.isFinite(assignment.weight) && assignment.weight > 0 ? assignment.weight : 0;
    weights.set(assignment.evaluatorKey, weight);
    total += weight;
  }
  if (total <= 0) {
    const count = assignments.length;
    const equal = count === 0 ? 0 : 1 / count;
    for (const assignment of assignments) {
      weights.set(assignment.evaluatorKey, equal);
    }
    return { weights, equalWeightsApplied: count > 0, total: count === 0 ? 0 : 1 };
  }
  for (const [key, weight] of weights) {
    weights.set(key, weight / total);
  }
  return { weights, equalWeightsApplied: false, total };
}

export interface AggregateInput {
  /** Every evaluator that was asked to score, with its raw weight. */
  assignments: readonly WeightedEvaluator[];
  /** Results that came back (may be a subset — that is the point). */
  results: readonly EvaluationResultRecord[];
  policy?: ScoringPolicy;
  /** Weighted score at or above which the case passes. */
  passThreshold?: number | null;
}

export function aggregateResults(input: AggregateInput): AggregateScore {
  const policy = input.policy ?? DEFAULT_SCORING_POLICY;
  const normalization = normalizeWeights(input.assignments);
  const byKey = new Map(input.results.map((result) => [result.evaluatorKey, result]));

  const contributions: Array<{ evaluatorKey: string; weight: number; normalizedScore: number; status: EvaluationResultRecord["status"] }> = [];
  const missing: string[] = [];
  const errored: string[] = [];
  let weightedScore = 0;
  let usableWeight = 0;
  let usableCount = 0;
  const allPassedFlags: Array<boolean | null> = [];

  for (const assignment of input.assignments) {
    const weight = normalization.weights.get(assignment.evaluatorKey) ?? 0;
    const result = byKey.get(assignment.evaluatorKey);
    const usable =
      result !== undefined &&
      result.status === "COMPLETED" &&
      result.normalizedScore !== null &&
      result.normalizedScore !== undefined;

    if (!usable) {
      missing.push(assignment.evaluatorKey);
      if (result?.status === "ERROR") {
        errored.push(assignment.evaluatorKey);
      }
      contributions.push({
        evaluatorKey: assignment.evaluatorKey,
        weight,
        normalizedScore: 0,
        status: result?.status ?? "SKIPPED",
      });
      continue;
    }

    const score = result.normalizedScore as number;
    contributions.push({
      evaluatorKey: assignment.evaluatorKey,
      weight,
      normalizedScore: score,
      status: result.status,
    });
    weightedScore += weight * score;
    usableWeight += weight;
    usableCount += 1;
    allPassedFlags.push(result.passed ?? null);
  }

  const scored = input.assignments.length > 0;

  type Base = Omit<AggregateScore, "contributions" | "explanation">;
  const finish = (base: Base, explanation: string): AggregateScore => ({
    ...base,
    contributions,
    explanation: normalization.equalWeightsApplied
      ? `${explanation} (No weights were configured, so every evaluator counts equally.)`
      : explanation,
  });

  const empty: Base = {
    score: null,
    maxScore: 1,
    status: "FAILED",
    passed: null,
    policy,
    missing: [],
    errored: [],
  };

  if (!scored) {
    return finish(empty, "No evaluators were configured for this evaluation.");
  }

  if (usableCount === 0) {
    return finish(
      { ...empty, missing, errored },
      `No evaluator produced a usable score (${errored.length} errored, ${missing.length - errored.length} skipped).`,
    );
  }

  if (policy === "REQUIRE_ALL" && missing.length > 0) {
    return finish(
      {
        score: null,
        maxScore: 1,
        status: "INCOMPLETE",
        passed: null,
        policy,
        missing,
        errored,
      },
      `Incomplete: ${missing.length} of ${input.assignments.length} evaluator(s) produced no score (${missing.join(", ")}). The policy for this evaluation is REQUIRE_ALL, so no aggregate score is reported.`,
    );
  }

  const score = usableWeight > 0 ? Number((weightedScore / usableWeight).toFixed(6)) : null;
  const threshold = input.passThreshold ?? null;
  let passed: boolean | null;
  if (score === null) {
    passed = null;
  } else if (threshold !== null) {
    passed = score >= threshold;
  } else {
    const explicit = allPassedFlags.filter((flag): flag is boolean => flag !== null);
    passed = explicit.length === allPassedFlags.length && explicit.length > 0 ? explicit.every(Boolean) : null;
  }

  const incomplete = missing.length > 0;
  const parts = [
    `Weighted score ${score === null ? "n/a" : score.toFixed(3)} from ${usableCount}/${input.assignments.length} evaluator(s)`,
  ];
  if (incomplete) {
    parts.push(
      `renormalised over ${usableCount} scored evaluator(s); ${missing.join(", ")} produced no score (IGNORE_MISSING)`,
    );
  }
  if (threshold !== null) {
    parts.push(passed === true ? `at or above the ${threshold} pass mark` : `below the ${threshold} pass mark`);
  }

  return finish(
    {
      score,
      maxScore: 1,
      status: incomplete ? "INCOMPLETE" : "COMPLETE",
      passed,
      policy,
      missing,
      errored,
    },
    `${parts.join("; ")}.`,
  );
}

/** Mean of the scored aggregates, ignoring nulls. Null when nothing scored. */
export function meanScore(scores: readonly (number | null)[]): number | null {
  const usable = scores.filter((score): score is number => score !== null && Number.isFinite(score));
  if (usable.length === 0) {
    return null;
  }
  return Number((usable.reduce((sum, score) => sum + score, 0) / usable.length).toFixed(6));
}

/** Median of the scored aggregates, ignoring nulls. */
export function medianScore(scores: readonly (number | null)[]): number | null {
  const usable = scores
    .filter((score): score is number => score !== null && Number.isFinite(score))
    .sort((a, b) => a - b);
  if (usable.length === 0) {
    return null;
  }
  const middle = Math.floor(usable.length / 2);
  if (usable.length % 2 === 1) {
    return Number(usable[middle]?.toFixed(6));
  }
  const lower = usable[middle - 1] ?? 0;
  const upper = usable[middle] ?? 0;
  return Number(((lower + upper) / 2).toFixed(6));
}
