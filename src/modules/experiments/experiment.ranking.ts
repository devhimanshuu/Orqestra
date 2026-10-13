/**
 * Objective-based ranking.
 *
 * The rules, stated plainly, because a leaderboard that hides its rules is worse
 * than no leaderboard:
 *
 *  1. **Constraints are hard.** A candidate that violates a configured ceiling
 *     (cost, latency, pass-rate floor, …) is *ineligible* and is ranked after
 *     every eligible candidate, with the violation quoted. A higher primary
 *     metric never buys a violation.
 *  2. **Unmeasured is not satisfied.** A constraint that has no measurement yet
 *     blocks a win instead of silently passing.
 *  3. **Incomplete evidence blocks a win.** A candidate with pending or running
 *     executions, or with no scored case at all, cannot lead — its row is marked
 *     provisional instead.
 *  4. **Ranking uses the objective's metric and direction.** No composite score
 *     exists unless the author configured one; nothing is silently weighted.
 *  5. **Ties are broken transparently** by the configured secondary metrics and
 *     then by label — never by an opaque score.
 *  6. **The baseline competes.** If nothing beats the baseline, the baseline is
 *     the leader and the note says so.
 *  7. **A win is not a statistical claim.** The leader note distinguishes
 *     "best measured value" from "statistically supported improvement"; the
 *     latter needs the paired evidence from `experiment.statistics`.
 */

import type { CandidateMetrics } from "./experiment.metrics";
import type {
  CandidateAnalysis,
} from "./experiment.comparison";
import { evaluateConstraints, metricDefinition, type ConstraintEvaluation } from "./experiment.objective";
import type {
  ExperimentConstraints,
  ExperimentObjective,
  ExperimentStatus,
} from "./experiment.types";
import { isTerminalExperimentStatus } from "./experiment.types";

export interface RankedCandidate {
  /**
   * Per-case comparison against the baseline. Null when this view did not load
   * the per-case data (for example the experiment list): ranking on the stored
   * metrics still works, but no statistical claim is made.
   */
  analysis: CandidateAnalysis | null;
  metrics: CandidateMetrics;
  constraints: ConstraintEvaluation;
  /** Value of the objective's primary metric (null = not measured). */
  primaryValue: number | null;
  /** Secondary metric values in the configured order. */
  secondaryValues: Array<{ metric: string; direction: "maximize" | "minimize"; value: number | null }>;
  /** 1-based rank among eligible, measured candidates; null when not ranked. */
  rank: number | null;
  eligibleForWin: boolean;
  /** Why this candidate cannot be presented as the winner (empty = it can). */
  winBlockers: string[];
  /** Transparent, ordered reasons for the position. */
  reasons: string[];
}

export interface ExperimentRanking {
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  baselineCandidateId: string | null;
  candidates: RankedCandidate[];
  leader: { candidateId: string; label: string; role: string; statisticalSupport: boolean } | null;
  leaderNote: string;
  /** True when every execution of every candidate reached a terminal status. */
  settled: boolean;
  /** Caveats about evidence quality, shown with the ranking. */
  notes: string[];
}

export interface RankingEntry {
  analysis: CandidateAnalysis | null;
  metrics: CandidateMetrics;
}

export interface RankCandidatesInput {
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  status: ExperimentStatus;
  baselineCandidateId: string | null;
  entries: RankingEntry[];
}

function compareNumbers(
  a: number | null,
  b: number | null,
  direction: "maximize" | "minimize",
): number {
  // Unmeasured values always sort last: absence of evidence is not a value.
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return direction === "maximize" ? b - a : a - b;
}

export function rankCandidates(input: RankCandidatesInput): ExperimentRanking {
  return rankEntries(input);
}

/**
 * The ranking itself, over entries that may or may not carry a per-case analysis.
 * Exposed directly because the experiments list ranks from *stored metrics* — it
 * has no per-case data — and must use the very same rules as the comparison view.
 */
export function rankEntries(input: RankCandidatesInput): ExperimentRanking {
  const primaryDefinition = metricDefinition(input.objective.primary.metric);
  const primaryDirection = input.objective.primary.direction;
  const notes: string[] = [];

  const candidates: RankedCandidate[] = input.entries.map((entry) => {
    const constraints = evaluateConstraints(entry.metrics, input.constraints);
    const primaryValue = primaryDefinition.read(entry.metrics);
    const secondaryValues = input.objective.secondary.map((spec) => ({
      metric: spec.metric,
      direction: spec.direction,
      value: metricDefinition(spec.metric).read(entry.metrics),
    }));

    const winBlockers: string[] = [];
    if (constraints.violated > 0) {
      for (const check of constraints.checks.filter((item) => item.satisfied === false)) {
        winBlockers.push(check.explanation);
      }
    }
    if (constraints.unknown > 0) {
      winBlockers.push(
        `${constraints.unknown} configured constraint(s) cannot be judged yet because the data is not measured.`,
      );
    }
    if (entry.metrics.pending > 0 || entry.metrics.running > 0) {
      winBlockers.push(
        `${entry.metrics.pending + entry.metrics.running} execution(s) are still outstanding, so this row is provisional.`,
      );
    }
    if (entry.metrics.scored === 0) {
      winBlockers.push("No execution of this candidate produced an aggregate score.");
    }

    const analysis = entry.analysis;
    const reasons: string[] = [];
    reasons.push(
      primaryValue === null
        ? `${primaryDefinition.label}: not measured.`
        : `${primaryDefinition.label}: ${primaryDefinition.format(primaryValue)}.`,
    );
    if (analysis !== null && analysis.role !== "BASELINE") {
      reasons.push(analysis.primary.explanation);
      if (analysis.evidence.verdict === "supported_improvement") {
        reasons.push(`Paired evidence supports the improvement: ${analysis.evidence.explanation}`);
      } else if (analysis.evidence.verdict === "supported_regression") {
        reasons.push(`Paired evidence supports a regression: ${analysis.evidence.explanation}`);
      } else {
        reasons.push(`Paired evidence: ${analysis.evidence.explanation}`);
      }
      if (analysis.regressions.length > 0) {
        reasons.push(`${analysis.regressions.length} regression(s) to review before promoting.`);
      }
      if (analysis.pathChanges.length > 0) {
        reasons.push(`${analysis.pathChanges.length} case(s) ran a different execution path.`);
      }
    }
    if (constraints.constrained > 0) {
      reasons.push(
        constraints.violated === 0
          ? `${constraints.satisfied}/${constraints.constrained} configured constraint(s) satisfied.`
          : `${constraints.violated} configured constraint(s) violated.`,
      );
    }

    return {
      analysis,
      metrics: entry.metrics,
      constraints,
      primaryValue,
      secondaryValues,
      rank: null,
      eligibleForWin: winBlockers.length === 0,
      winBlockers,
      reasons,
    };
  });

  // Eligible candidates first, then by the objective's primary metric, then by
  // the secondary metrics in order, then by label — deterministic and explainable.
  const ordered = [...candidates].sort((a, b) => {
    const eligibility = Number(b.eligibleForWin) - Number(a.eligibleForWin);
    if (eligibility !== 0) {
      return eligibility;
    }
    const primary = compareNumbers(a.primaryValue, b.primaryValue, primaryDirection);
    if (primary !== 0) {
      return primary;
    }
    for (let index = 0; index < a.secondaryValues.length; index += 1) {
      const aValue = a.secondaryValues[index];
      const bValue = b.secondaryValues[index];
      if (aValue === undefined || bValue === undefined) {
        continue;
      }
      const secondary = compareNumbers(aValue.value, bValue.value, aValue.direction);
      if (secondary !== 0) {
        return secondary;
      }
    }
    return a.metrics.label.localeCompare(b.metrics.label);
  });

  let rank = 0;
  for (const candidate of ordered) {
    if (candidate.eligibleForWin && candidate.primaryValue !== null) {
      rank += 1;
      candidate.rank = rank;
    }
  }

  const settled =
    isTerminalExperimentStatus(input.status) &&
    candidates.every((candidate) => candidate.metrics.pending === 0 && candidate.metrics.running === 0);

  const leaderCandidate = ordered.find((candidate) => candidate.rank === 1) ?? null;
  const leader =
    settled && leaderCandidate !== null
      ? {
          candidateId: leaderCandidate.metrics.candidateId,
          label: leaderCandidate.metrics.label,
          role: leaderCandidate.metrics.role,
          statisticalSupport:
            leaderCandidate.analysis !== null &&
            leaderCandidate.metrics.role !== "BASELINE" &&
            leaderCandidate.analysis.evidence.verdict === "supported_improvement",
        }
      : null;

  if (!settled) {
    const outstanding = candidates.reduce(
      (sum, candidate) => sum + candidate.metrics.pending + candidate.metrics.running,
      0,
    );
    notes.push(
      outstanding > 0
        ? `No winner is declared while ${outstanding} execution(s) are still outstanding. Rows below are provisional.`
        : "No winner is declared until the experiment reaches a terminal status.",
    );
  } else if (leaderCandidate === null) {
    notes.push(
      candidates.length === 0
        ? "No candidates were sealed into this experiment."
        : "No candidate satisfies every configured constraint with measured data, so no winner is declared.",
    );
  }

  if (leader !== null && leader.role !== "BASELINE" && !leader.statisticalSupport) {
    const evidence = leaderCandidate?.analysis?.evidence;
    notes.push(
      evidence === undefined
        ? "The leading candidate's advantage is observed, not statistically supported."
        : `The leading candidate's advantage is observed, not statistically supported: ${evidence.explanation}`,
    );
  }
  if (leader !== null && leader.role === "BASELINE") {
    notes.push("No candidate beat the baseline under the configured objective and constraints.");
  }

  const insufficient = candidates.filter(
    (candidate) =>
      candidate.analysis !== null &&
      candidate.metrics.role !== "BASELINE" &&
      candidate.analysis.evidence.verdict === "insufficient_sample",
  ).length;
  if (insufficient > 0) {
    notes.push(
      `${insufficient} candidate(s) were compared on fewer paired cases than the documented minimum sample (8), so their differences are observations rather than significance.`,
    );
  }
  if (candidates.some((candidate) => candidate.analysis === null)) {
    notes.push(
      "Per-case paired evidence is evaluated on the experiment's comparison view; this ranking used the stored metrics only.",
    );
  }

  const primaryLabel = primaryDefinition.label;
  const leaderNote =
    leader === null
      ? (notes[0] ?? "No winner declared.")
      : leader.role === "BASELINE"
        ? `Baseline is leading on ${primaryLabel}: no candidate improved it under the configured objective and constraints.`
        : `${leader.label} leads on ${primaryLabel}${leader.statisticalSupport ? " with statistically supported paired evidence" : " (observed difference; not statistically supported)"}.`;

  return {
    objective: input.objective,
    constraints: input.constraints,
    baselineCandidateId: input.baselineCandidateId,
    candidates: ordered,
    leader,
    leaderNote,
    settled,
    notes,
  };
}
