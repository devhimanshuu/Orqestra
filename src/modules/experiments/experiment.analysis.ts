/**
 * Read-side assembly for an experiment.
 *
 * One pass loads the persisted case executions of every candidate, and everything
 * a view needs is derived from that single load: per-candidate metrics, progress
 * counts, per-case observations, the comparison against the baseline and the
 * ranking. Views therefore cannot disagree with each other, and a page render
 * costs a fixed number of queries regardless of how many cases the experiment has
 * (three queries for the case rows, never one per case).
 *
 * Nothing here writes. The orchestrator writes; this module reads.
 */

import { evaluationRepository } from "@/modules/evaluation/evaluation.repository";
import type { BatchStatus } from "@/modules/evaluation/batch.types";
import { experimentRepository, type ExperimentCaseMetricRow } from "./experiment.repository";
import {
  aggregateCaseObservations,
  computeCandidateMetrics,
  computeExperimentMetrics,
  type CandidateMetrics,
  type ExperimentMetrics,
} from "./experiment.metrics";
import { analyzeCandidate, type CandidateAnalysis, type CandidateAnalysisInput } from "./experiment.comparison";
import { rankCandidates, type ExperimentRanking } from "./experiment.ranking";
import {
  isActiveExperimentStatus,
  isTerminalExperimentStatus,
  type CandidateProgress,
  type ExperimentCandidateRecord,
  type ExperimentCandidateSummary,
  type ExperimentCaseObservation,
  type ExperimentDetail,
  type ExperimentProgress,
  type ExperimentRecord,
} from "./experiment.types";

export interface LoadedCandidateData {
  metrics: CandidateMetrics;
  observations: ExperimentCaseObservation[];
}

export interface LoadedExperiment {
  experiment: ExperimentRecord;
  candidates: ExperimentCandidateRecord[];
  rows: ExperimentCaseMetricRow[];
  /** Per-candidate metrics and per-case observations, keyed by candidate id. */
  byCandidate: Map<string, LoadedCandidateData>;
  /** Batch status per candidate, ordered by replicate. */
  batchStatuses: Map<string, Array<{ replicate: number; batchId: string; status: BatchStatus }>>;
  /** Aggregate metrics as they will be persisted when the experiment settles. */
  experimentMetrics: ExperimentMetrics;
  progress: ExperimentProgress;
}

function candidateInputs(experiment: ExperimentRecord, candidates: ExperimentCandidateRecord[]) {
  return candidates.map((candidate) => ({
    candidateId: candidate.id,
    label: candidate.label,
    role: candidate.role,
    harnessVersionId: candidate.harnessVersionId,
    harnessVersion: candidate.harnessVersion,
    policy: experiment.scoringPolicy,
    plannedExecutions: experiment.caseCount * candidate.replicates.length,
    rows: [] as ExperimentCaseMetricRow[],
  }));
}

/**
 * Loads an experiment with everything derived from its persisted case rows.
 *
 * `batchStatuses` come from the batch rows themselves (the authority on whether a
 * replicate is still running), so the UI can show a truthful "running" badge even
 * between metric recomputations.
 */
export async function loadExperiment(experiment: ExperimentRecord): Promise<LoadedExperiment> {
  const candidates = await experimentRepository.listCandidates(experiment.id);
  const batches = candidates.flatMap((candidate) =>
    candidate.replicates.map((replicate) => ({
      evaluationBatchId: replicate.evaluationBatchId,
      candidateId: candidate.id,
      replicate: replicate.replicate,
    })),
  );

  const rows = await experimentRepository.caseMetricRows({
    batches,
    passThreshold: experiment.passThreshold,
  });

  const rowsByCandidate = new Map<string, ExperimentCaseMetricRow[]>();
  for (const row of rows) {
    const bucket = rowsByCandidate.get(row.candidateId) ?? [];
    bucket.push(row);
    rowsByCandidate.set(row.candidateId, bucket);
  }

  const byCandidate = new Map<string, LoadedCandidateData>();
  const inputs = candidateInputs(experiment, candidates);
  for (const input of inputs) {
    input.rows = rowsByCandidate.get(input.candidateId) ?? [];
    const metrics = computeCandidateMetrics(input);
    byCandidate.set(input.candidateId, {
      metrics,
      observations: aggregateCaseObservations({
        samples: experiment.datasetSnapshot,
        rows: input.rows,
      }),
    });
  }

  const experimentMetrics = computeExperimentMetrics({
    plannedExecutions: experiment.plannedRunCount,
    caseCount: experiment.caseCount,
    policy: experiment.scoringPolicy,
    candidates: inputs,
  });

  const batchStatusMap = new Map<string, Array<{ replicate: number; batchId: string; status: BatchStatus }>>();
  for (const candidate of candidates) {
    const statuses: Array<{ replicate: number; batchId: string; status: BatchStatus }> = [];
    for (const replicate of candidate.replicates) {
      const batch = await evaluationRepository.findById(replicate.evaluationBatchId);
      statuses.push({
        replicate: replicate.replicate,
        batchId: replicate.evaluationBatchId,
        status: batch?.status ?? "PENDING",
      });
    }
    batchStatusMap.set(candidate.id, statuses);
  }

  return {
    experiment,
    candidates,
    rows,
    byCandidate,
    batchStatuses: batchStatusMap,
    experimentMetrics,
    progress: computeProgress(experiment, candidates, inputs, experimentMetrics),
  };
}

/** Progress derived from the case rows — never from a counter kept in memory. */
export function computeProgress(
  experiment: ExperimentRecord,
  candidates: ExperimentCandidateRecord[],
  inputs: Array<{ candidateId: string; rows: ExperimentCaseMetricRow[] }>,
  metrics: ExperimentMetrics,
): ExperimentProgress {
  const perCandidate: CandidateProgress[] = candidates.map((candidate) => {
    const metricsEntry = metrics.candidates.find((entry) => entry.candidateId === candidate.id);
    const plannedExecutions = experiment.caseCount * Math.max(1, candidate.replicates.length);
    const settled =
      (metricsEntry?.completed ?? 0) +
      (metricsEntry?.failed ?? 0) +
      (metricsEntry?.skipped ?? 0) +
      (metricsEntry?.cancelled ?? 0);
    return {
      candidateId: candidate.id,
      caseCount: experiment.caseCount,
      plannedExecutions,
      completed: metricsEntry?.completed ?? 0,
      failed: metricsEntry?.failed ?? 0,
      skipped: metricsEntry?.skipped ?? 0,
      cancelled: metricsEntry?.cancelled ?? 0,
      running: metricsEntry?.running ?? 0,
      pending: Math.max(0, plannedExecutions - settled - (metricsEntry?.running ?? 0)),
      percent: plannedExecutions === 0 ? 0 : settled / plannedExecutions,
    };
  });

  const plannedExecutions = experiment.plannedRunCount;
  const settled =
    metrics.completed + metrics.failed + metrics.skipped + metrics.cancelled;

  return {
    status: experiment.status,
    caseCount: experiment.caseCount,
    plannedExecutions,
    completed: metrics.completed,
    failed: metrics.failed,
    cancelled: metrics.cancelled,
    skipped: metrics.skipped,
    running: metrics.running,
    pending: metrics.pending,
    percent: plannedExecutions === 0 ? 0 : settled / plannedExecutions,
    candidates: perCandidate,
    cancellable: !isTerminalExperimentStatus(experiment.status),
    pausable: experiment.status === "QUEUED" || experiment.status === "RUNNING",
    resumable: experiment.status === "PAUSED",
  };
}

/** Candidate rows with their progress and batch status, for the detail table. */
export function candidateSummaries(input: {
  loaded: LoadedExperiment;
}): ExperimentCandidateSummary[] {
  const { experiment, candidates, batchStatuses, progress } = input.loaded;
  const progressByCandidate = new Map(progress.candidates.map((entry) => [entry.candidateId, entry]));

  return candidates.map((candidate) => {
    return {
      id: candidate.id,
      label: candidate.label,
      role: candidate.role,
      hypothesis: candidate.hypothesis,
      orderIndex: candidate.orderIndex,
      harnessId: candidate.harnessId,
      harnessVersionId: candidate.harnessVersionId,
      harnessVersion: candidate.harnessVersion,
      contentHash: candidate.contentHash,
      harnessName: candidate.harnessSnapshot.harnessName,
      batchStatuses: batchStatuses.get(candidate.id) ?? [],
      progress:
        progressByCandidate.get(candidate.id) ??
        {
          candidateId: candidate.id,
          caseCount: experiment.caseCount,
          plannedExecutions: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          cancelled: 0,
          running: 0,
          pending: 0,
          percent: 0,
        },
    };
  });
}

/** Everything the detail page shows, assembled in one call. */
export function toExperimentDetail(input: {
  loaded: LoadedExperiment;
  agent: { id: string; name: string } | null;
  dataset: { id: string; name: string; slug: string; version: number } | null;
}): ExperimentDetail {
  const { experiment } = input.loaded;
  return {
    experiment,
    progress: input.loaded.progress,
    agent: input.agent,
    harnessCount: new Set(input.loaded.candidates.map((candidate) => candidate.harnessId)).size,
    dataset: input.dataset,
    candidates: candidateSummaries({ loaded: input.loaded }),
    evaluators: experiment.evaluatorConfig.map((assignment) => ({
      key: assignment.key,
      name: assignment.name,
      kind: assignment.kind,
      version: assignment.evaluatorVersion,
      weight: assignment.weight,
      usesLlm: assignment.usesLlm,
    })),
  };
}

/** Per-candidate comparison inputs, sharing one baseline observation set. */
export function buildCandidateAnalyses(input: {
  experiment: ExperimentRecord;
  candidates: ExperimentCandidateRecord[];
  byCandidate: Map<string, LoadedCandidateData>;
}): Map<string, CandidateAnalysis> {
  const baseline =
    input.candidates.find((candidate) => candidate.role === "BASELINE") ?? input.candidates[0] ?? null;
  const orderedCaseKeys = input.experiment.datasetSnapshot.map((entry) => entry.caseKey);
  const analyses = new Map<string, CandidateAnalysis>();

  if (baseline === null) {
    return analyses;
  }

  const toInput = (candidate: ExperimentCandidateRecord): CandidateAnalysisInput => {
    const data = input.byCandidate.get(candidate.id);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      role: candidate.role,
      harnessVersionId: candidate.harnessVersionId,
      harnessVersion: candidate.harnessVersion,
      harnessNodeCount: candidate.harnessSnapshot.nodeCount,
      metrics:
        data?.metrics ??
        computeCandidateMetrics({
          candidateId: candidate.id,
          label: candidate.label,
          role: candidate.role,
          harnessVersionId: candidate.harnessVersionId,
          harnessVersion: candidate.harnessVersion,
          policy: input.experiment.scoringPolicy,
          plannedExecutions: 0,
          rows: [],
        }),
      observations: data?.observations ?? [],
    };
  };

  const baselineInput = toInput(baseline);
  for (const candidate of input.candidates) {
    analyses.set(
      candidate.id,
      analyzeCandidate({
        baseline: baselineInput,
        candidate: toInput(candidate),
        objective: input.experiment.objective,
        datasetId: input.experiment.datasetId,
        datasetVersionId: input.experiment.datasetVersionId,
        scoringPolicy: input.experiment.scoringPolicy,
        passThreshold: input.experiment.passThreshold,
        orderedCaseKeys,
      }),
    );
  }

  return analyses;
}

/**
 * Ranks the candidates. `analyses` are optional: the list view ranks on stored
 * metrics only, while the detail and comparison views pass the per-case analyses
 * so statistical evidence is part of the verdict.
 */
export function rankLoaded(input: {
  experiment: ExperimentRecord;
  candidates: ExperimentCandidateRecord[];
  byCandidate: Map<string, LoadedCandidateData>;
  analyses?: Map<string, CandidateAnalysis>;
}): ExperimentRanking {
  const baseline = input.candidates.find((candidate) => candidate.role === "BASELINE") ?? null;
  return rankCandidates({
    objective: input.experiment.objective,
    constraints: input.experiment.constraints,
    status: input.experiment.status,
    baselineCandidateId: baseline?.id ?? null,
    entries: input.candidates.map((candidate) => ({
      analysis: input.analyses?.get(candidate.id) ?? null,
      metrics:
        input.byCandidate.get(candidate.id)?.metrics ??
        computeCandidateMetrics({
          candidateId: candidate.id,
          label: candidate.label,
          role: candidate.role,
          harnessVersionId: candidate.harnessVersionId,
          harnessVersion: candidate.harnessVersion,
          policy: input.experiment.scoringPolicy,
          plannedExecutions: 0,
          rows: [],
        }),
    })),
  });
}

/** True while the orchestrator may still schedule executions. */
export function experimentIsActive(experiment: ExperimentRecord): boolean {
  return isActiveExperimentStatus(experiment.status);
}

/**
 * Whether the experiment's stored metrics should be refreshed: the orchestrator
 * calls this when cases settle, so a long experiment shows honest progress
 * without a write on every read.
 */
export function metricsAreStale(experiment: ExperimentRecord): boolean {
  const metrics = experiment.metrics;
  if (metrics === null) {
    return true;
  }
  return metrics.pending !== 0 || metrics.running !== 0 || !metrics.complete;
}
