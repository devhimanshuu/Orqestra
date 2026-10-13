/**
 * Candidate comparison and regression detection.
 *
 * Two deliberate reuses, so an experiment and an evaluation can never disagree
 * about the same data:
 *
 *  - **Alignment and metric deltas come from the Phase 3 engine.** A candidate is
 *    projected into a `ComparableBatch` (same dataset, pinned version, cases
 *    aligned by their stable `caseKey`) and handed to `compareBatches`, which
 *    already refuses incompatible datasets, computes deltas with null-safe
 *    denominators, and derives the pass→fail regression list.
 *  - **Paired statistics come from `experiment.statistics`.** The per-case scores
 *    of the two sides become a paired sample, and the verdict says whether the
 *    observed movement is statistically supported or merely observed.
 *
 * What this module adds on top:
 *
 *  - a *case-level* regression classification that keeps different findings
 *    apart — pass→fail, no verdict where the baseline had one, quality decline
 *    while both still passed, and (reported separately, as a lead rather than a
 *    verdict) a changed execution path;
 *  - the primary/secondary metric view the objective asks for, with percentage
 *    changes that are `null` — never infinite — when the baseline denominator is
 *    zero;
 *  - explicit `null`s everywhere data is missing: "we did not measure this" and
 *    "this measured zero" never look alike.
 */

import {
  compareBatches,
  type BatchComparison,
  type ComparableBatch,
  type ComparableCase,
} from "@/modules/evaluation/comparison";
import type { AggregateStatus, ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import { metricDefinition } from "./experiment.objective";
import { assessEvidence, type EvidenceAssessment, type PairedDifference } from "./experiment.statistics";
import type { CandidateMetrics } from "./experiment.metrics";
import type {
  ExperimentCandidateRole,
  ExperimentCaseObservation as Observation,
  ExperimentObjective,
} from "./experiment.types";

// ------------------------------------------------------------------------------
// Metric deltas
// ------------------------------------------------------------------------------

export interface MetricComparison {
  key: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  baseline: number | null;
  candidate: number | null;
  /** candidate − baseline, or null when either side is unmeasured. */
  delta: number | null;
  /** Percentage change (already multiplied by 100), null when the baseline is zero or unmeasured. */
  deltaPercent: number | null;
  direction: "improved" | "regressed" | "unchanged" | "unknown";
  /** The movement explained in words, for the UI's "why" column. */
  explanation: string;
}

export function compareMetric(input: {
  key: string;
  label: string;
  unit?: string;
  higherIsBetter: boolean;
  baseline: number | null;
  candidate: number | null;
}): MetricComparison {
  const { baseline, candidate, higherIsBetter } = input;

  if (baseline === null || candidate === null) {
    const missingSide = baseline === null && candidate === null ? "both sides" : baseline === null ? "the baseline" : "the candidate";
    return {
      key: input.key,
      label: input.label,
      unit: input.unit ?? "",
      higherIsBetter,
      baseline,
      candidate,
      delta: null,
      deltaPercent: null,
      direction: "unknown",
      explanation: `Not measured on ${missingSide}.`,
    };
  }

  const delta = Number((candidate - baseline).toFixed(6));
  const deltaPercent =
    Math.abs(baseline) < 1e-12 ? null : Number(((delta / Math.abs(baseline)) * 100).toFixed(2));
  const direction: MetricComparison["direction"] =
    Math.abs(delta) < 1e-9 ? "unchanged" : (delta > 0) === higherIsBetter ? "improved" : "regressed"; 
  const percentText =
    deltaPercent === null
      ? "the baseline is zero, so no percentage change is meaningful"
      : `${deltaPercent > 0 ? "+" : ""}${deltaPercent}%`;

  return {
    key: input.key,
    label: input.label,
    unit: input.unit ?? "",
    higherIsBetter,
    baseline,
    candidate,
    delta,
    deltaPercent,
    direction,
    explanation:
      direction === "unchanged"
        ? `Unchanged at ${formatMetric(input.label, candidate)}.`
        : `${formatMetric(input.label, baseline)} → ${formatMetric(input.label, candidate)} (${percentText}), which is a ${direction === "improved" ? "improvement" : "regression"} for this metric.`,
  };
}

function formatMetric(label: string, value: number): string {
  const unitLabel = label.toLowerCase();
  if (unitLabel.includes("cost")) {
    return `$${value.toFixed(4)}`;
  }
  if (unitLabel.includes("latency")) {
    return `${Math.round(value)} ms`;
  }
  if (unitLabel.includes("rate") || unitLabel.includes("pass rate")) {
    return `${Math.round(value * 100)}%`;
  }
  if (unitLabel.includes("token")) {
    return `${Math.round(value)} tokens`;
  }
  return value.toFixed(3);
}

// ------------------------------------------------------------------------------
// Regressions
// ------------------------------------------------------------------------------

export type RegressionKind =
  | "pass_to_fail"
  | "missing_verdict"
  | "score_decline"
  | "execution_failed";

export interface RegressionFinding {
  kind: RegressionKind | "execution_path_changed";
  caseKey: string;
  name: string | null;
  /** True for findings that are verdicts (failures), false for leads. */
  isRegression: boolean;
  baseline: { score: number | null; passed: boolean | null; status: string; steps: number | null };
  candidate: { score: number | null; passed: boolean | null; status: string; steps: number | null };
  detail: string;
}

/** The most representative trial of a case: the first that produced a verdict. */
function trialSummary(observation: Observation): { status: string; steps: number | null } {
  const judged = observation.trials.find((trial) => trial.passed !== null) ?? observation.trials[0];
  if (judged === undefined) {
    return { status: "PENDING", steps: null };
  }
  return { status: judged.status, steps: judged.steps };
}

export function detectRegressions(input: {
  baseline: Observation[];
  candidate: Observation[];
  /** Include cases where the candidate executed a different number of nodes. */
  detectPathChanges?: boolean;
}): RegressionFinding[] {
  const baselineByKey = new Map(input.baseline.map((entry) => [entry.caseKey, entry]));
  const findings: RegressionFinding[] = [];

  for (const candidateCase of input.candidate) {
    const baseCase = baselineByKey.get(candidateCase.caseKey);
    if (baseCase === undefined) {
      continue;
    }
    const baseTrial = trialSummary(baseCase);
    const candidateTrial = trialSummary(candidateCase);

    const base = {
      score: baseCase.meanScore,
      passed: baseCase.passed,
      status: baseTrial.status,
      steps: baseTrial.steps,
    };
    const candidate = {
      score: candidateCase.meanScore,
      passed: candidateCase.passed,
      status: candidateTrial.status,
      steps: candidateTrial.steps,
    };

    // A changed execution path is a lead, not a verdict: the harness behaved
    // differently, which is worth reading before the numbers alone are trusted.
    // It is recorded even when a verdict rule below also fires — a regression
    // must never hide how the run actually differed from the baseline.
    if (
      input.detectPathChanges !== false &&
      baseTrial.steps !== null &&
      candidateTrial.steps !== null &&
      baseTrial.steps !== candidateTrial.steps
    ) {
      findings.push({
        kind: "execution_path_changed",
        caseKey: candidateCase.caseKey,
        name: candidateCase.name,
        isRegression: false,
        baseline: base,
        candidate,
        detail: `The candidate executed ${candidateTrial.steps} node(s) where the baseline executed ${baseTrial.steps} — the path changed, so compare the traces before trusting the score.`,
      });
    }

    // 1. The baseline passed and the candidate does not.
    if (baseCase.passed === true && candidateCase.passed === false) {
      findings.push({
        kind: "pass_to_fail",
        caseKey: candidateCase.caseKey,
        name: candidateCase.name,
        isRegression: true,
        baseline: base,
        candidate,
        detail: `Passed on the baseline (${formatScore(baseCase.meanScore)}), fails on the candidate (${formatScore(candidateCase.meanScore)}).`,
      });
      continue;
    }

    // 2. The candidate produced no verdict where the baseline produced one.
    if (
      baseCase.passed !== null &&
      candidateCase.passed === null &&
      (candidateTrial.status === "FAILED" || candidateTrial.status === "CANCELLED")
    ) {
      findings.push({
        kind: "missing_verdict",
        caseKey: candidateCase.caseKey,
        name: candidateCase.name,
        isRegression: true,
        baseline: base,
        candidate,
        detail:
          candidateTrial.status === "FAILED"
            ? `The candidate's execution failed, so the case has no verdict (baseline scored ${formatScore(baseCase.meanScore)}).`
            : `The candidate's execution was cancelled, so the case has no verdict.`,
      });
      continue;
    }

    // 3. Both passed, but quality declined.
    if (
      baseCase.passed === true &&
      candidateCase.passed === true &&
      baseCase.meanScore !== null &&
      candidateCase.meanScore !== null &&
      candidateCase.meanScore < baseCase.meanScore - 1e-9
    ) {
      findings.push({
        kind: "score_decline",
        caseKey: candidateCase.caseKey,
        name: candidateCase.name,
        isRegression: true,
        baseline: base,
        candidate,
        detail: `Both passed, but the score fell from ${formatScore(baseCase.meanScore)} to ${formatScore(candidateCase.meanScore)}.`,
      });
      continue;
    }

    // 4. The candidate's run failed outright.
    if (baseTrial.status === "COMPLETED" && candidateTrial.status === "FAILED") {
      findings.push({
        kind: "execution_failed",
        caseKey: candidateCase.caseKey,
        name: candidateCase.name,
        isRegression: true,
        baseline: base,
        candidate,
        detail: "The candidate's run failed where the baseline completed.",
      });
      continue;
    }

  }

  return findings.sort((a, b) => Number(b.isRegression) - Number(a.isRegression) || a.caseKey.localeCompare(b.caseKey));
}

function formatScore(value: number | null): string {
  return value === null ? "no score" : value.toFixed(3);
}

/** Path changes worth reading, reported separately from regressions. */
export function pathChanges(findings: readonly RegressionFinding[]): RegressionFinding[] {
  return findings.filter((entry) => entry.kind === "execution_path_changed");
}

// ------------------------------------------------------------------------------
// Candidate analysis
// ------------------------------------------------------------------------------

export interface CandidateAnalysisInput {
  candidateId: string;
  label: string;
  role: ExperimentCandidateRole;
  harnessVersionId: string;
  harnessVersion: number;
  harnessNodeCount: number;
  metrics: CandidateMetrics;
  observations: Observation[];
}

export interface CandidateAnalysis {
  candidateId: string;
  label: string;
  role: ExperimentCandidateRole;
  /** False when the two sides share no aligned case at all. */
  comparable: boolean;
  /** The full Phase 3 comparison (metrics, movements, verdict, headline). */
  comparison: BatchComparison | null;
  alignment: BatchComparison["alignment"] | null;
  /** Paired per-case differences on the aggregate score. */
  paired: PairedDifference[];
  evidence: EvidenceAssessment;
  primary: MetricComparison;
  secondary: MetricComparison[];
  /** Improvement/regression counts on case movement. */
  caseMovement: { improved: number; regressed: number; unchanged: number };
  regressions: RegressionFinding[];
  pathChanges: RegressionFinding[];
  /** True while any execution of this candidate is still outstanding. */
  incomplete: boolean;
  notes: string[];
}

function caseStatusOf(observation: Observation): string {
  if (observation.trials.some((trial) => trial.status === "COMPLETED")) {
    return "COMPLETED";
  }
  const statuses = new Set(observation.trials.map((trial) => trial.status));
  if (statuses.has("RUNNING")) {
    return "RUNNING";
  }
  if (statuses.has("FAILED")) {
    return "FAILED";
  }
  if (statuses.has("CANCELLED")) {
    return "CANCELLED";
  }
  if (statuses.has("SKIPPED")) {
    return "SKIPPED";
  }
  return "PENDING";
}

/** Projects a candidate onto the Phase 3 comparison shape (no numbers recomputed). */
export function toComparableBatch(input: {
  analysis: CandidateAnalysisInput;
  datasetId: string;
  datasetVersionId: string;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  orderedCaseKeys: readonly string[];
}): ComparableBatch {
  const { metrics, observations } = input.analysis;
  const byKey = new Map(observations.map((entry) => [entry.caseKey, entry]));

  const cases: ComparableCase[] = input.orderedCaseKeys
    .map((caseKey) => byKey.get(caseKey))
    .filter((entry): entry is Observation => entry !== undefined)
    .map((entry) => ({
      caseKey: entry.caseKey,
      name: entry.name,
      status: caseStatusOf(entry),
      aggregateScore: entry.meanScore,
      aggregateStatus: (entry.trials.find((trial) => trial.aggregateStatus !== null)?.aggregateStatus ??
        null) as AggregateStatus | null,
      passed: entry.passed,
    }));

  return {
    id: input.analysis.candidateId,
    label: input.analysis.label,
    datasetId: input.datasetId,
    datasetVersionId: input.datasetVersionId,
    harnessId: input.analysis.candidateId,
    harnessVersionId: input.analysis.harnessVersionId,
    harnessVersionLabel: input.analysis.harnessVersion,
    status: metrics.pending > 0 || metrics.running > 0 ? "RUNNING" : "COMPLETED",
    scoringPolicy: input.scoringPolicy,
    passThreshold: input.passThreshold,
    caseCount: cases.length,
    completedCount: metrics.completed,
    failedCount: metrics.failed,
    metrics: {
      passRate: metrics.passRate,
      passed: metrics.passed,
      failed: metrics.failedVerdicts,
      meanScore: metrics.score.mean,
      medianScore: metrics.score.median,
      averageLatencyMs: metrics.latency.averageMs,
      totalTokens: metrics.tokens.total,
      tokenReports: metrics.tokens.reported,
      cost: metrics.cost,
      retries: metrics.retries,
      toolInvocations: metrics.toolInvocations,
      nodeExecutions: cases.length * input.analysis.harnessNodeCount,
      errorCategories: metrics.errorCategories,
    },
    cases,
  };
}

/**
 * Compares one candidate against the baseline.
 *
 * `baseline` and `candidate` are the two candidates' analyses; the baseline is
 * compared *with itself* when the candidate is the baseline, which yields a
 * neutral result instead of an empty panel.
 */
export function analyzeCandidate(input: {
  baseline: CandidateAnalysisInput;
  candidate: CandidateAnalysisInput;
  objective: ExperimentObjective;
  datasetId: string;
  datasetVersionId: string;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  orderedCaseKeys: readonly string[];
}): CandidateAnalysis {
  const isBaseline = input.baseline.candidateId === input.candidate.candidateId;

  const baselineBatch = toComparableBatch({
    analysis: input.baseline,
    datasetId: input.datasetId,
    datasetVersionId: input.datasetVersionId,
    scoringPolicy: input.scoringPolicy,
    passThreshold: input.passThreshold,
    orderedCaseKeys: input.orderedCaseKeys,
  });
  const candidateBatch = toComparableBatch({
    analysis: input.candidate,
    datasetId: input.datasetId,
    datasetVersionId: input.datasetVersionId,
    scoringPolicy: input.scoringPolicy,
    passThreshold: input.passThreshold,
    orderedCaseKeys: input.orderedCaseKeys,
  });

  const comparison = compareBatches(baselineBatch, candidateBatch);

  const candidateByKey = new Map(input.candidate.observations.map((entry) => [entry.caseKey, entry]));
  const paired: PairedDifference[] = input.baseline.observations.map((baseCase) => {
    const candidateCase = candidateByKey.get(baseCase.caseKey);
    return {
      caseKey: baseCase.caseKey,
      baseline: baseCase.meanScore,
      candidate: candidateCase?.meanScore ?? null,
      difference:
        baseCase.meanScore === null || candidateCase?.meanScore === null || candidateCase === undefined
          ? null
          : Number((candidateCase.meanScore - baseCase.meanScore).toFixed(6)),
    };
  });

  const primaryDefinition = metricDefinition(input.objective.primary.metric);
  const higherIsBetter = input.objective.primary.direction === "maximize";
  const evidence = isBaseline
    ? assessEvidence({ differences: [], higherIsBetter })
    : assessEvidence({ differences: paired, higherIsBetter });

  const primary = compareMetric({
    key: input.objective.primary.metric,
    label: primaryDefinition.label,
    higherIsBetter,
    baseline: primaryDefinition.read(input.baseline.metrics),
    candidate: primaryDefinition.read(input.candidate.metrics),
  });

  const secondary = input.objective.secondary.map((spec) => {
    const definition = metricDefinition(spec.metric);
    return compareMetric({
      key: spec.metric,
      label: definition.label,
      higherIsBetter: spec.direction === "maximize",
      baseline: definition.read(input.baseline.metrics),
      candidate: definition.read(input.candidate.metrics),
    });
  });

  const findings = detectRegressions({
    baseline: input.baseline.observations,
    candidate: input.candidate.observations,
  });

  const notes: string[] = [];
  if (comparison.alignment.onlyInBaseline.length > 0) {
    notes.push(
      `${comparison.alignment.onlyInBaseline.length} case(s) exist only on the baseline side — they are excluded from the paired comparison rather than treated as failures.`,
    );
  }
  if (comparison.alignment.onlyInCandidate.length > 0) {
    notes.push(
      `${comparison.alignment.onlyInCandidate.length} case(s) exist only on the candidate side — they are excluded from the paired comparison.`,
    );
  }
  if (input.candidate.metrics.incomplete > 0) {
    notes.push(
      `${input.candidate.metrics.incomplete} execution(s) produced an incomplete aggregate (an evaluator reported nothing), so their scores are not counted.`,
    );
  }
  if (input.candidate.metrics.unscored > 0) {
    notes.push(
      `${input.candidate.metrics.unscored} execution(s) produced no aggregate score; failures are counted separately and never replaced by a zero.`,
    );
  }

  return {
    candidateId: input.candidate.candidateId,
    label: input.candidate.label,
    role: input.candidate.role,
    comparable: comparison.alignment.scoredOnBoth > 0,
    comparison,
    alignment: comparison.alignment,
    paired,
    evidence,
    primary,
    secondary,
    caseMovement: {
      improved: comparison.improvements.length,
      regressed: comparison.regressions.length,
      unchanged: comparison.unchanged,
    },
    regressions: findings.filter((entry) => entry.isRegression),
    pathChanges: pathChanges(findings),
    incomplete: input.candidate.metrics.pending > 0 || input.candidate.metrics.running > 0,
    notes,
  };
}
