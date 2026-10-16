/**
 * Optimization history.
 *
 * The cross-session question Phase 5 leaves open: *which kinds of change
 * actually work?* A single session answers "did this candidate beat the
 * baseline"; this module answers "across every session we have run, what does a
 * mutation strategy tend to achieve, per weakness".
 *
 * Design rules, unchanged from the rest of the module:
 *
 *  1. **Everything is derived from stored rows.** A category's acceptance rate is
 *     `accepted / evaluated` over real candidate rows; there is no smoothing, no
 *     prior, and no score invented for a session that produced none.
 *  2. **Missing is not zero.** `null` means "not measured" everywhere: a rate
 *     over zero evaluated candidates is null, and a mean improvement ignores
 *     candidates whose delta could not be computed rather than counting them as
 *     no change.
 *  3. **Sample size is stated, never implied.** `evidence` classifies a category
 *     only by how many *measured* comparisons back it, reusing the acceptance
 *     policy's thresholds so the two surfaces tell the same story. Observed
 *     effect size and statistical confidence stay separate facts.
 *  4. **The aggregation is pure.** Rows go in, a read model comes out — no
 *     database, no clock, no model. The rules can be tested directly and the
 *     same rows always produce the same history.
 *
 * Attribution, stated because it is a judgement call:
 *
 *  - A candidate is attributed to the failure category of the hypothesis it
 *    tests, and to the strategy that produced that hypothesis (`origin`), not to
 *    the session's configured strategy. A manual or LLM candidate has no
 *    hypothesis, so it has no category; it is reported under `unattributed`
 *    rather than credited to a weakness it was never aimed at.
 */

import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type { ExperimentMetricKey, MetricDirection } from "@/modules/experiments/experiment.types";
import {
  improvementOf,
  MIN_ESTABLISHED_SAMPLE,
  MIN_SCORED_CASES,
  readBatchMetric,
} from "../policies/acceptance";
import type {
  CandidateValidation,
  FailureCategory,
  FindingConfidence,
  ImprovementHypothesisRecord,
  MutationChange,
  OptimizationCandidateStatus,
  OptimizationDecisionKind,
  OptimizationObjective,
  OptimizationStatus,
  OptimizationStrategyKind,
} from "../optimization.types";

// ------------------------------------------------------------------------------
// Facts (what the repository hands us, and what the tests construct)
// ------------------------------------------------------------------------------

export interface HistoryCandidateFact {
  id: string;
  label: string;
  iteration: number;
  status: OptimizationCandidateStatus;
  decisionKind: OptimizationDecisionKind | null;
  /** The category of the hypothesis this candidate tests; null when unattributed. */
  category: FailureCategory | null;
  /** The strategy that produced the hypothesis, else the session's own strategy. */
  strategy: OptimizationStrategyKind;
  /** Direction-aware movement on the session's primary metric; null if unmeasured. */
  improvement: number | null;
  /** The same movement as a fraction of the baseline; null if unmeasured or baseline 0. */
  relativeImprovement: number | null;
  /** Mutation operation discriminators this candidate was built from. */
  operations: string[];
}

export interface HistorySessionFact {
  id: string;
  name: string;
  strategy: OptimizationStrategyKind;
  status: OptimizationStatus;
  stopReason: string | null;
  primaryMetric: ExperimentMetricKey;
  direction: MetricDirection;
  createdAt: Date;
  completedAt: Date | null;
  findings: Array<{ category: FailureCategory; confidence: FindingConfidence; isLlm: boolean }>;
  hypotheses: Array<{
    id: string;
    category: FailureCategory;
    origin: OptimizationStrategyKind;
    status: ImprovementHypothesisRecord["status"];
  }>;
  candidates: HistoryCandidateFact[];
}

/** The raw shapes the repository reads; mapped to facts by `toHistoryFacts`. */
export interface HistorySessionRow {
  session: {
    id: string;
    name: string;
    strategy: OptimizationStrategyKind;
    status: OptimizationStatus;
    stopReason: string | null;
    objective: OptimizationObjective;
    createdAt: Date;
    completedAt: Date | null;
  };
  findings: Array<{ category: string; confidence: string; isLlm: boolean }>;
  hypotheses: Array<{ id: string; category: string; origin: string; status: string }>;
  candidates: Array<{
    id: string;
    label: string;
    iteration: number;
    hypothesisId: string | null;
    status: string;
    decisionKind: string | null;
    metrics: BatchMetrics | null;
    baselineMetrics: BatchMetrics | null;
    validation: CandidateValidation | null;
    changeSet: MutationChange[] | null;
  }>;
}

// ------------------------------------------------------------------------------
// Read model
// ------------------------------------------------------------------------------

/**
 * How much measured evidence backs a category.
 *
 * `insufficient` is not a failure — it is the honest answer while a workspace has
 * run two sessions. The thresholds are the acceptance policy's own, so a category
 * is never called established here while a single candidate would be called
 * indicative there.
 */
export type HistoryEvidence = "insufficient" | "suggestive" | "established";

export interface MutationOperationEffectiveness {
  operation: string;
  candidates: number;
  accepted: number;
  rejected: number;
  invalid: number;
  acceptanceRate: number | null;
}

export interface StrategyEffectiveness {
  strategy: OptimizationStrategyKind;
  /** Sessions that proposed at least one candidate for this group. */
  sessions: number;
  candidates: number;
  evaluated: number;
  accepted: number;
  rejected: number;
  invalid: number;
  /** accepted / evaluated. Null when nothing was evaluated. */
  acceptanceRate: number | null;
  /**
   * The metric the means below are in — the one most of this group's measured
   * candidates optimized. Null when nothing was measured.
   */
  metric: ExperimentMetricKey | null;
  /**
   * True when the measured candidates span more than one primary metric. The
   * means then cover only `metric`; the rest are counted by `measuredExcluded`, never
   * silently averaged across incompatible units.
   */
  mixedMetrics: boolean;
  /** Mean measured movement in `metric`'s units (direction-aware). */
  meanImprovement: number | null;
  /** Mean movement as a fraction of the baseline, over the same samples. */
  meanRelativeImprovement: number | null;
  /** Candidates contributing a measured improvement (the mean's own denominator). */
  measured: number;
  /** Measured candidates left out of the mean because they used another metric. */
  measuredExcluded: number;
  operations: MutationOperationEffectiveness[];
}

export interface FailureCategoryEffectiveness {
  category: FailureCategory;
  /** Findings of this category across every session in scope. */
  findings: number;
  /** Distinct sessions that observed the category. */
  sessions: number;
  hypotheses: number;
  candidates: number;
  evaluated: number;
  accepted: number;
  rejected: number;
  invalid: number;
  acceptanceRate: number | null;
  /** The unit the means are in; see `StrategyEffectiveness.metric`. */
  metric: ExperimentMetricKey | null;
  mixedMetrics: boolean;
  meanImprovement: number | null;
  meanRelativeImprovement: number | null;
  measured: number;
  measuredExcluded: number;
  evidence: HistoryEvidence;
  /** The strategy with the best mean relative improvement, when any is measured. */
  bestStrategy: OptimizationStrategyKind | null;
  byStrategy: StrategyEffectiveness[];
  operations: MutationOperationEffectiveness[];
}

export interface HistoryTotals {
  sessions: number;
  settledSessions: number;
  sessionsWithFindings: number;
  findings: number;
  hypotheses: number;
  candidates: number;
  evaluated: number;
  accepted: number;
  rejected: number;
  invalid: number;
  measuredComparisons: number;
  /** Findings a model shaped rather than observed — never counted as facts. */
  llmFindings: number;
}

export interface OptimizationHistory {
  generatedAt: string;
  filters: {
    projectId: string | null;
    agentId: string | null;
    since: string | null;
  };
  totals: HistoryTotals;
  categories: FailureCategoryEffectiveness[];
  /**
   * Candidates that test no hypothesis (manual and LLM-assisted proposals), plus
   * findings-only sessions. Reported separately rather than credited to a
   * category the candidate was never aimed at.
   */
  unattributed: {
    sessions: number;
    candidates: number;
    evaluated: number;
    accepted: number;
    rejected: number;
    invalid: number;
    operations: MutationOperationEffectiveness[];
  } | null;
  /** What this history does and does not establish, in the platform's own words. */
  notes: string[];
}

// ------------------------------------------------------------------------------
// Mapping
// ------------------------------------------------------------------------------

/**
 * Turns stored rows into facts.
 *
 * The improvement is computed the way the acceptance policy computes it
 * (`readBatchMetric` + `improvementOf`), so a candidate's delta in this view is
 * the same number that was used to accept or reject it — not a second opinion.
 */
export function toHistoryFacts(rows: readonly HistorySessionRow[]): HistorySessionFact[] {
  return rows.map((row) => {
    const { metric, direction } = row.session.objective.primary;
    const hypothesisById = new Map(row.hypotheses.map((entry) => [entry.id, entry]));

    const candidates: HistoryCandidateFact[] = row.candidates.map((candidate) => {
      const hypothesis = candidate.hypothesisId === null ? null : (hypothesisById.get(candidate.hypothesisId) ?? null);
      const baseline = readBatchMetric(candidate.baselineMetrics, metric);
      const measured = readBatchMetric(candidate.metrics, metric);
      // Direction-aware, like `improvementOf`: a cheaper (minimize) candidate has
      // a *positive* relative improvement, so the field means the same thing in
      // every category regardless of which way its metric points.
      const relative =
        baseline === null || measured === null || baseline === 0
          ? null
          : direction === "maximize"
            ? (measured - baseline) / Math.abs(baseline)
            : (baseline - measured) / Math.abs(baseline);
      return {
        id: candidate.id,
        label: candidate.label,
        iteration: candidate.iteration,
        status: candidate.status as OptimizationCandidateStatus,
        decisionKind: (candidate.decisionKind as OptimizationDecisionKind | null) ?? null,
        category: hypothesis === null ? null : (hypothesis.category as FailureCategory),
        strategy: (hypothesis === null
          ? row.session.strategy
          : (hypothesis.origin as OptimizationStrategyKind)),
        improvement: improvementOf(baseline, measured, direction),
        relativeImprovement: relative,
        operations: operationNamesOf(candidate.changeSet),
      };
    });

    return {
      id: row.session.id,
      name: row.session.name,
      strategy: row.session.strategy,
      status: row.session.status,
      stopReason: row.session.stopReason,
      primaryMetric: metric,
      direction,
      createdAt: row.session.createdAt,
      completedAt: row.session.completedAt,
      findings: row.findings.map((finding) => ({
        category: finding.category as FailureCategory,
        confidence: finding.confidence as FindingConfidence,
        isLlm: finding.isLlm,
      })),
      hypotheses: row.hypotheses.map((hypothesis) => ({
        id: hypothesis.id,
        category: hypothesis.category as FailureCategory,
        origin: hypothesis.origin as OptimizationStrategyKind,
        status: hypothesis.status as ImprovementHypothesisRecord["status"],
      })),
      candidates,
    };
  });
}

/** The distinct operations a candidate's change set applied, in first-seen order. */
function operationNamesOf(changeSet: MutationChange[] | null): string[] {
  if (changeSet === null) {
    return [];
  }
  const seen: string[] = [];
  for (const change of changeSet) {
    if (change.operation !== "" && !seen.includes(change.operation)) {
      seen.push(change.operation);
    }
  }
  return seen;
}

// ------------------------------------------------------------------------------
// Aggregation
// ------------------------------------------------------------------------------

/** Mean of the measured values, or null when nothing was measured. */
function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function classifyEvidence(measured: number): HistoryEvidence {
  if (measured >= MIN_ESTABLISHED_SAMPLE) {
    return "established";
  }
  if (measured >= MIN_SCORED_CASES) {
    return "suggestive";
  }
  return "insufficient";
}

interface MetricSamples {
  improvements: number[];
  relatives: number[];
}

interface Tally {
  candidates: number;
  evaluated: number;
  accepted: number;
  rejected: number;
  invalid: number;
  /**
   * Measured movements, grouped by the primary metric they were measured on.
   * Deliberately not one flat list: two sessions optimizing different metrics
   * produce numbers in different units, and averaging them would be arithmetic
   * on nothing.
   */
  samplesByMetric: Map<string, MetricSamples>;
  sessions: Set<string>;
  operations: Map<string, { candidates: number; accepted: number; rejected: number; invalid: number }>;
}

function emptyTally(): Tally {
  return {
    candidates: 0,
    evaluated: 0,
    accepted: 0,
    rejected: 0,
    invalid: 0,
    samplesByMetric: new Map(),
    sessions: new Set<string>(),
    operations: new Map(),
  };
}

/**
 * The metric a group's means are in: the one with the most measured samples,
 * ties broken alphabetically so the same rows always pick the same one.
 */
function dominantMetric(samples: Map<string, MetricSamples>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [metric, bucket] of samples) {
    const count = bucket.improvements.length;
    if (count > bestCount || (count === bestCount && best !== null && metric.localeCompare(best) < 0)) {
      best = metric;
      bestCount = count;
    }
  }
  return best;
}

function samplesOf(
  samples: Map<string, MetricSamples>,
  metric: string | null,
): MetricSamples {
  if (metric === null) {
    return { improvements: [], relatives: [] };
  }
  return samples.get(metric) ?? { improvements: [], relatives: [] };
}

function tallyCandidate(
  tally: Tally,
  candidate: HistoryCandidateFact,
  sessionId: string,
  metric: string,
): void {
  tally.sessions.add(sessionId);
  tally.candidates += 1;
  if (candidate.status === "EVALUATED") {
    tally.evaluated += 1;
  }
  if (candidate.status === "INVALID") {
    tally.invalid += 1;
  }
  if (candidate.decisionKind === "ACCEPT") {
    tally.accepted += 1;
  } else if (candidate.decisionKind === "REJECT") {
    tally.rejected += 1;
  }
  if (candidate.improvement !== null) {
    const bucket = tally.samplesByMetric.get(metric) ?? { improvements: [], relatives: [] };
    bucket.improvements.push(candidate.improvement);
    if (candidate.relativeImprovement !== null) {
      bucket.relatives.push(candidate.relativeImprovement);
    }
    tally.samplesByMetric.set(metric, bucket);
  }
  for (const operation of candidate.operations) {
    const bucket = tally.operations.get(operation) ?? {
      candidates: 0,
      accepted: 0,
      rejected: 0,
      invalid: 0,
    };
    bucket.candidates += 1;
    if (candidate.decisionKind === "ACCEPT") {
      bucket.accepted += 1;
    } else if (candidate.decisionKind === "REJECT") {
      bucket.rejected += 1;
    }
    if (candidate.status === "INVALID") {
      bucket.invalid += 1;
    }
    tally.operations.set(operation, bucket);
  }
}

function operationsOf(tally: Tally): MutationOperationEffectiveness[] {
  return [...tally.operations.entries()]
    .map(([operation, bucket]) => ({
      operation,
      candidates: bucket.candidates,
      accepted: bucket.accepted,
      rejected: bucket.rejected,
      invalid: bucket.invalid,
      acceptanceRate: bucket.candidates === 0 ? null : bucket.accepted / bucket.candidates,
    }))
    // Deterministic: most-used first, then alphabetical.
    .sort((a, b) => b.candidates - a.candidates || a.operation.localeCompare(b.operation));
}

function summarizeStrategy(strategy: OptimizationStrategyKind, tally: Tally): StrategyEffectiveness {
  const metric = dominantMetric(tally.samplesByMetric);
  const samples = samplesOf(tally.samplesByMetric, metric);
  return {
    strategy,
    sessions: tally.sessions.size,
    candidates: tally.candidates,
    evaluated: tally.evaluated,
    accepted: tally.accepted,
    rejected: tally.rejected,
    invalid: tally.invalid,
    acceptanceRate: tally.evaluated === 0 ? null : tally.accepted / tally.evaluated,
    metric: (metric as ExperimentMetricKey | null) ?? null,
    mixedMetrics: tally.samplesByMetric.size > 1,
    meanImprovement: meanOf(samples.improvements),
    meanRelativeImprovement: meanOf(samples.relatives),
    measured: samples.improvements.length,
    measuredExcluded: totalMeasured(tally.samplesByMetric) - samples.improvements.length,
    operations: operationsOf(tally),
  };
}

function totalMeasured(samples: Map<string, MetricSamples>): number {
  let total = 0;
  for (const bucket of samples.values()) {
    total += bucket.improvements.length;
  }
  return total;
}

export interface BuildHistoryInput {
  sessions: readonly HistorySessionFact[];
  generatedAt: Date;
  filters?: {
    projectId?: string | null;
    agentId?: string | null;
    since?: Date | null;
  };
}

/**
 * Aggregates session facts into the history read model.
 *
 * Categories are ordered by how much they have actually been worked on
 * (evaluated candidates), then findings, then name — a stable order, so a
 * screenshot and the API response agree.
 */
export function buildOptimizationHistory(input: BuildHistoryInput): OptimizationHistory {
  const categories = new Map<FailureCategory, Tally>();
  const strategyByCategory = new Map<FailureCategory, Map<OptimizationStrategyKind, Tally>>();
  const categoryHypotheses = new Map<FailureCategory, number>();
  const categoryFindings = new Map<FailureCategory, number>();
  const categorySessions = new Map<FailureCategory, Set<string>>();
  const unattributed = emptyTally();

  const totals: HistoryTotals = {
    sessions: input.sessions.length,
    settledSessions: input.sessions.filter((session) => session.completedAt !== null).length,
    sessionsWithFindings: 0,
    findings: 0,
    hypotheses: 0,
    candidates: 0,
    evaluated: 0,
    accepted: 0,
    rejected: 0,
    invalid: 0,
    measuredComparisons: 0,
    llmFindings: 0,
  };

  const unattributedCandidates: HistoryCandidateFact[] = [];

  for (const session of input.sessions) {
    for (const finding of session.findings) {
      totals.findings += 1;
      if (finding.isLlm) {
        totals.llmFindings += 1;
      }
      categoryFindings.set(finding.category, (categoryFindings.get(finding.category) ?? 0) + 1);
      const sessions = categorySessions.get(finding.category) ?? new Set<string>();
      sessions.add(session.id);
      categorySessions.set(finding.category, sessions);
    }
    if (session.findings.length > 0) {
      totals.sessionsWithFindings += 1;
    }

    for (const hypothesis of session.hypotheses) {
      totals.hypotheses += 1;
      categoryHypotheses.set(
        hypothesis.category,
        (categoryHypotheses.get(hypothesis.category) ?? 0) + 1,
      );
      // A hypothesis without candidates still marks the category as engaged.
      const sessions = categorySessions.get(hypothesis.category) ?? new Set<string>();
      sessions.add(session.id);
      categorySessions.set(hypothesis.category, sessions);
    }

    for (const candidate of session.candidates) {
      totals.candidates += 1;
      if (candidate.status === "EVALUATED") {
        totals.evaluated += 1;
      }
      if (candidate.status === "INVALID") {
        totals.invalid += 1;
      }
      if (candidate.decisionKind === "ACCEPT") {
        totals.accepted += 1;
      } else if (candidate.decisionKind === "REJECT") {
        totals.rejected += 1;
      }
      if (candidate.improvement !== null) {
        totals.measuredComparisons += 1;
      }

      if (candidate.category === null) {
        unattributedCandidates.push(candidate);
        tallyCandidate(unattributed, candidate, session.id, session.primaryMetric);
        continue;
      }

      const tally = categories.get(candidate.category) ?? emptyTally();
      tallyCandidate(tally, candidate, session.id, session.primaryMetric);
      categories.set(candidate.category, tally);

      const byStrategy = strategyByCategory.get(candidate.category) ?? new Map<OptimizationStrategyKind, Tally>();
      const strategyTally = byStrategy.get(candidate.strategy) ?? emptyTally();
      tallyCandidate(strategyTally, candidate, session.id, session.primaryMetric);
      byStrategy.set(candidate.strategy, strategyTally);
      strategyByCategory.set(candidate.category, byStrategy);
    }
  }

  const categoryKeys = new Set<FailureCategory>([
    ...categories.keys(),
    ...categoryHypotheses.keys(),
    ...categoryFindings.keys(),
  ]);

  const summaries: FailureCategoryEffectiveness[] = [...categoryKeys].map((category) => {
    const tally = categories.get(category) ?? emptyTally();
    const metric = dominantMetric(tally.samplesByMetric);
    const samples = samplesOf(tally.samplesByMetric, metric);
    const byStrategy = [...(strategyByCategory.get(category) ?? new Map()).entries()]
      .map(([strategy, strategyTally]) => summarizeStrategy(strategy, strategyTally))
      .sort((a, b) => {
        // Best measured improvement first; unmeasured strategies sink.
        const aMean = a.meanRelativeImprovement ?? Number.NEGATIVE_INFINITY;
        const bMean = b.meanRelativeImprovement ?? Number.NEGATIVE_INFINITY;
        if (aMean !== bMean) {
          return bMean - aMean;
        }
        return a.strategy.localeCompare(b.strategy);
      });
    const best = byStrategy.find((entry) => entry.meanRelativeImprovement !== null) ?? null;
    return {
      category,
      findings: categoryFindings.get(category) ?? 0,
      sessions: (categorySessions.get(category) ?? new Set<string>()).size,
      hypotheses: categoryHypotheses.get(category) ?? 0,
      candidates: tally.candidates,
      evaluated: tally.evaluated,
      accepted: tally.accepted,
      rejected: tally.rejected,
      invalid: tally.invalid,
      acceptanceRate: tally.evaluated === 0 ? null : tally.accepted / tally.evaluated,
      metric: (metric as ExperimentMetricKey | null) ?? null,
      mixedMetrics: tally.samplesByMetric.size > 1,
      meanImprovement: meanOf(samples.improvements),
      meanRelativeImprovement: meanOf(samples.relatives),
      measured: samples.improvements.length,
      measuredExcluded: totalMeasured(tally.samplesByMetric) - samples.improvements.length,
      evidence: classifyEvidence(samples.improvements.length),
      bestStrategy: best === null ? null : best.strategy,
      byStrategy,
      operations: operationsOf(tally),
    } satisfies FailureCategoryEffectiveness;
  });

  summaries.sort(
    (a, b) =>
      b.evaluated - a.evaluated ||
      b.candidates - a.candidates ||
      b.findings - a.findings ||
      a.category.localeCompare(b.category),
  );

  const unattributedSummary: OptimizationHistory["unattributed"] =
    unattributed.candidates === 0 && unattributedCandidates.length === 0
      ? null
      : {
          sessions: unattributed.sessions.size,
          candidates: unattributed.candidates,
          evaluated: unattributed.evaluated,
          accepted: unattributed.accepted,
          rejected: unattributed.rejected,
          invalid: unattributed.invalid,
          operations: operationsOf(unattributed),
        };

  const notes: string[] = [];
  if (totals.sessions === 0) {
    notes.push("No optimization sessions match this scope yet, so there is no history to compare.");
  } else {
    notes.push(
      `Derived from ${totals.sessions} session(s): ${totals.evaluated} evaluated candidate(s), ${totals.accepted} accepted, ${totals.rejected} rejected.`,
    );
  }
  const mixed = summaries.filter((summary) => summary.mixedMetrics).length;
  if (mixed > 0) {
    notes.push(
      `${mixed} category(ies) contain candidates measured on different primary metrics. Their means cover the most-measured metric in each group; the rest are excluded from the mean rather than averaged across units.`,
    );
  }
  if (totals.measuredComparisons === 0 && totals.candidates > 0) {
    notes.push(
      "No candidate has a comparable baseline measurement yet, so no improvement can be reported for any category.",
    );
  }
  const insufficient = summaries.filter((summary) => summary.evidence === "insufficient").length;
  if (insufficient > 0) {
    notes.push(
      `${insufficient} category(ies) rest on fewer than ${MIN_SCORED_CASES} measured comparison(s); their rates are observations, not established improvements.`,
    );
  }
  if (totals.llmFindings > 0) {
    notes.push(
      `${totals.llmFindings} finding(s) were shaped by a model and are hypotheses about the evidence, not measurements of it.`,
    );
  }
  if (unattributedSummary !== null) {
    notes.push(
      `${unattributedSummary.candidates} candidate(s) test no hypothesis (manual or LLM-assisted), so they are reported without a failure category.`,
    );
  }
  notes.push(
    "Acceptance rates are policy outcomes — constraints and thresholds decide them — not a measure of how much a change helps.",
  );

  return {
    generatedAt: input.generatedAt.toISOString(),
    filters: {
      projectId: input.filters?.projectId ?? null,
      agentId: input.filters?.agentId ?? null,
      since: input.filters?.since?.toISOString() ?? null,
    },
    totals,
    categories: summaries,
    unattributed: unattributedSummary,
    notes,
  };
}
