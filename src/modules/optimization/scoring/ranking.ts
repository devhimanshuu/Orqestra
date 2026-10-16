/**
 * Ranking.
 *
 * Ranks candidates by what the objective asked for, and *only* among candidates
 * that passed every hard constraint. A rejected candidate is never ranked above
 * an accepted one no matter how good its primary metric looks — the same rule the
 * acceptance policy enforces, applied to ordering.
 *
 * Ties break on cost, then label, so the leader is deterministic: the same rows
 * always produce the same recommendation.
 */

import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type {
  OptimizationCandidateStatus,
  OptimizationDecisionKind,
  OptimizationObjective,
} from "../optimization.types";
import { improvementOf, readBatchMetric } from "../policies/acceptance";

export interface RankingCandidateInput {
  id: string;
  label: string;
  status: OptimizationCandidateStatus;
  decisionKind: OptimizationDecisionKind | null;
  metrics: BatchMetrics | null;
}

export interface RankedCandidate {
  candidateId: string;
  label: string;
  status: OptimizationCandidateStatus;
  decisionKind: OptimizationDecisionKind | null;
  /** True only for ACCEPT-ed candidates with a complete evaluation. */
  eligible: boolean;
  primary: number | null;
  costUsd: number | null;
  /** Direction-aware movement against the baseline; null when not measurable. */
  improvement: number | null;
  rank: number;
}

export interface RankingResult {
  entries: RankedCandidate[];
  leader: RankedCandidate | null;
  /** Why there is no leader, when there is none. */
  note: string | null;
}

function decisionRank(kind: OptimizationDecisionKind | null): number {
  if (kind === "ACCEPT") {
    return 0;
  }
  if (kind === "INCONCLUSIVE") {
    return 1;
  }
  if (kind === "REJECT") {
    return 2;
  }
  return 3;
}

export function rankOptimizationCandidates(input: {
  objective: OptimizationObjective;
  baseline: BatchMetrics | null;
  candidates: readonly RankingCandidateInput[];
}): RankingResult {
  const baselinePrimary = readBatchMetric(input.baseline, input.objective.primary.metric);

  const entries: RankedCandidate[] = input.candidates.map((candidate) => {
    const primary = readBatchMetric(candidate.metrics, input.objective.primary.metric);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      status: candidate.status,
      decisionKind: candidate.decisionKind,
      eligible: candidate.decisionKind === "ACCEPT" && candidate.status === "EVALUATED",
      primary,
      costUsd: candidate.metrics?.cost.costUsd ?? null,
      improvement: improvementOf(baselinePrimary, primary, input.objective.primary.direction),
      rank: 0,
    };
  });

  const minimize = input.objective.primary.direction === "minimize";
  entries.sort((a, b) => {
    if (a.eligible !== b.eligible) {
      return a.eligible ? -1 : 1;
    }
    const decision = decisionRank(a.decisionKind) - decisionRank(b.decisionKind);
    if (decision !== 0) {
      return decision;
    }
    // Better improvement first; unmeasured values sink.
    const aImprovement = a.improvement ?? Number.NEGATIVE_INFINITY;
    const bImprovement = b.improvement ?? Number.NEGATIVE_INFINITY;
    if (aImprovement !== bImprovement) {
      return bImprovement - aImprovement;
    }
    // Same movement: prefer the cheaper candidate, then the better raw value.
    const aCost = a.costUsd ?? Number.POSITIVE_INFINITY;
    const bCost = b.costUsd ?? Number.POSITIVE_INFINITY;
    if (aCost !== bCost) {
      return aCost - bCost;
    }
    const aPrimary = a.primary ?? (minimize ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const bPrimary = b.primary ?? (minimize ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    if (aPrimary !== bPrimary) {
      return minimize ? aPrimary - bPrimary : bPrimary - aPrimary;
    }
    return a.label.localeCompare(b.label);
  });

  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const leader = entries.find((entry) => entry.eligible) ?? null;
  if (leader !== null) {
    return { entries, leader, note: null };
  }

  const evaluated = entries.filter((entry) => entry.status === "EVALUATED");
  const note =
    entries.length === 0
      ? "No candidates have been proposed yet."
      : evaluated.length === 0
        ? "No candidate finished evaluation, so there is nothing to recommend."
        : "No candidate satisfied the acceptance policies — none is eligible for promotion.";
  return { entries, leader: null, note };
}
