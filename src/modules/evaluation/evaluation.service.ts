import type { AuthUser } from "@/lib/auth/provider";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { assertAgentAccess, assertDatasetAccess, assertHarnessAccess } from "@/modules/access/access.service";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { compileHarness } from "@/modules/runtime/compiler";
import { getRunDetail, loadRunObservation } from "@/modules/runtime/run.service";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { listProjects } from "@/modules/projects/project.service";
import { compareBatches, type BatchComparison, type ComparableBatch, type ComparableCase } from "./comparison";
import { datasetRepository } from "./dataset.repository";
import type { DatasetCaseSnapshot } from "./dataset.types";
import { evaluationRepository } from "./evaluation.repository";
import { resolveAssignments } from "./evaluator.service";
import { aggregateResults, DEFAULT_SCORING_POLICY } from "./scoring";
import { computeBatchMetrics, type BatchMetrics } from "./metrics";
import { runEvaluator } from "./evaluator.registry";
import { sanitizeValue } from "./sanitize";
import { EvaluationComparisonError } from "./evaluation.types";
import type { AggregateScore, EvaluationResultRecord } from "./evaluation.types";
import type {
  BatchProgress,
  EvaluationBatchDetail,
  EvaluationBatchRecord,
  EvaluationCaseRecord,
  EvaluationResultView,
  RunEvaluationGroup,
} from "./batch.types";
import {
  EvaluationBatchConflictError,
  EvaluationStartError,
  isTerminalBatchStatus,
} from "./batch.types";
import type {
  CompareBatchesQuery,
  EvaluateRunBody,
  ListBatchesQuery,
  ListCasesQuery,
  StartEvaluationBody,
} from "./evaluation.inputs";
import { MAX_BATCH_CONCURRENCY } from "./evaluation.inputs";
import { dispatchEvaluationBatch, type EvaluationDispatchResult } from "./jobs/dispatcher";
import { runEvaluationBatch } from "./jobs/orchestrator";

/**
 * Evaluation service — the only entry point for batch operations.
 *
 * Authorization chain (never trusting client ids):
 *   user → workspace → project → agent / harness version / dataset
 *
 * Sealing: a batch pins the harness version, the dataset version's cases and
 * every evaluator revision at creation. After that, editing a dataset or an
 * evaluator cannot change what a stored batch means — which is what makes a
 * comparison between two batches honest.
 */

const serviceLogger = logger.child({ module: "evaluation.batches" });

async function scopedProjectIds(user: AuthUser): Promise<string[]> {
  const projects = await listProjects(user);
  return projects.map((project) => project.id);
}

export interface StartedBatch {
  batch: EvaluationBatchRecord;
  dispatch: EvaluationDispatchResult;
}

export async function startEvaluationBatch(
  user: AuthUser,
  body: StartEvaluationBody,
): Promise<StartedBatch> {
  const agent = await assertAgentAccess(user.id, body.agentId);

  const harnessVersion = await harnessRepository.findVersionById(body.harnessVersionId);
  if (harnessVersion === null) {
    throw new NotFoundError("Harness version not found");
  }
  const harness = await assertHarnessAccess(user.id, harnessVersion.harnessId);
  if (harness.agentId !== agent.id) {
    throw new EvaluationStartError("That harness version does not belong to this agent");
  }
  const compiled = compileHarness(harnessVersion.definition);
  if (!compiled.ok) {
    throw new EvaluationStartError(
      `This harness version is not executable, so it cannot be evaluated: ${compiled.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const dataset = await assertDatasetAccess(user.id, body.datasetId);
  if (dataset.projectId !== agent.projectId) {
    throw new EvaluationStartError(
      "The dataset and the agent belong to different projects — an evaluation must stay inside one project",
    );
  }

  const datasetVersion =
    body.datasetVersionId !== undefined
      ? await datasetRepository.findVersionById(body.datasetVersionId)
      : await datasetRepository.findLatestVersion(dataset.id);
  if (datasetVersion === null || datasetVersion.datasetId !== dataset.id) {
    throw new NotFoundError("Dataset version not found");
  }
  if (datasetVersion.cases.length === 0) {
    throw new EvaluationStartError(
      "This dataset version has no test cases — add cases and publish a version first",
    );
  }

  const assignments = await resolveAssignments(user, body.evaluators);
  const snapshot: DatasetCaseSnapshot[] = datasetVersion.cases;

  // Two identical batches running at once would spend tokens twice for the same
  // answer, and would make the comparison view ambiguous. Refuse the duplicate.
  const clash = await evaluationRepository.findInFlight(harnessVersion.id, datasetVersion.id);
  if (clash !== null) {
    throw new EvaluationBatchConflictError(
      `An evaluation of this harness version against this dataset version is already running (batch ${clash.id.slice(-6)}).`,
    );
  }

  const concurrency = Math.min(body.concurrency ?? 1, MAX_BATCH_CONCURRENCY);
  const batch = await evaluationRepository.createBatch({
    projectId: agent.projectId,
    label: body.label ?? null,
    agentId: agent.id,
    harnessId: harness.id,
    harnessVersionId: harnessVersion.id,
    datasetId: dataset.id,
    datasetVersionId: datasetVersion.id,
    datasetSnapshot: snapshot,
    evaluatorConfig: assignments.map((assignment) => ({
      key: `${assignment.evaluatorId}@${assignment.evaluatorVersion}`,
      evaluatorId: assignment.evaluatorId,
      evaluatorVersion: assignment.evaluatorVersion,
      kind: assignment.kind as EvaluationBatchRecord["evaluatorConfig"][number]["kind"],
      name: assignment.name,
      weight: assignment.weight,
      config: assignment.config,
      usesLlm: assignment.kind === "llm_judge",
    })),
    harnessSnapshot: {
      harnessId: harness.id,
      harnessVersionId: harnessVersion.id,
      harnessVersion: harnessVersion.version,
      harnessName: harness.name,
      contentHash: harnessVersion.contentHash,
      entryNode: compiled.plan.entryNode,
      nodeCount: compiled.plan.stats.nodeCount,
      edgeCount: compiled.plan.stats.edgeCount,
    },
    scoringPolicy: body.scoringPolicy ?? DEFAULT_SCORING_POLICY,
    passThreshold: body.passThreshold ?? null,
    config: {
      concurrency,
      limits: body.limits ?? null,
    },
    createdBy: user.id,
  });

  const dispatch = await dispatchEvaluationBatch(batch.id);
  serviceLogger.info("evaluation batch started", {
    batchId: batch.id,
    harnessVersionId: harnessVersion.id,
    datasetVersionId: datasetVersion.id,
    cases: batch.caseCount,
    evaluators: batch.evaluatorConfig.length,
    concurrency,
    mode: dispatch.mode,
    userId: user.id,
  });

  const refreshed = await evaluationRepository.findById(batch.id);
  return { batch: refreshed ?? batch, dispatch };
}

export async function listEvaluationBatches(
  user: AuthUser,
  query: ListBatchesQuery,
): Promise<{ items: Awaited<ReturnType<typeof evaluationRepository.list>>["items"]; total: number; limit: number; offset: number }> {
  const projectIds = await scopedProjectIds(user);
  if (projectIds.length === 0) {
    return { items: [], total: 0, limit: query.limit ?? 20, offset: query.offset ?? 0 };
  }
  if (query.harnessId !== undefined) {
    await assertHarnessAccess(user.id, query.harnessId);
  }
  if (query.datasetId !== undefined) {
    await assertDatasetAccess(user.id, query.datasetId);
  }
  return evaluationRepository.list({
    projectIds,
    ...(query.harnessId !== undefined ? { harnessId: query.harnessId } : {}),
    ...(query.datasetId !== undefined ? { datasetId: query.datasetId } : {}),
    ...(query.status !== undefined && query.status.length > 0 ? { status: query.status } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  });
}

/** Loads a batch and asserts the caller may see its project. */
async function requireBatch(
  user: AuthUser,
  batchId: string,
): Promise<{ batch: EvaluationBatchRecord; detail: NonNullable<Awaited<ReturnType<typeof evaluationRepository.findDetail>>> }> {
  const detail = await evaluationRepository.findDetail(batchId);
  if (detail === null) {
    throw new NotFoundError("Evaluation batch not found");
  }
  await assertHarnessAccess(user.id, detail.batch.harnessId);
  return { batch: detail.batch, detail };
}

export async function getEvaluationBatch(
  user: AuthUser,
  batchId: string,
): Promise<EvaluationBatchDetail> {
  const { detail } = await requireBatch(user, batchId);
  const progress = await progressFor(detail.batch);
  return {
    batch: detail.batch,
    progress,
    agent: detail.agent,
    harness: detail.harness,
    dataset: detail.dataset,
  };
}

async function progressFor(batch: EvaluationBatchRecord): Promise<BatchProgress> {
  const counts = await evaluationRepository.countsByStatus(batch.id);
  const settled = counts.COMPLETED + counts.FAILED + counts.SKIPPED + counts.CANCELLED;
  return {
    status: batch.status,
    caseCount: batch.caseCount,
    completedCount: counts.COMPLETED,
    failedCount: counts.FAILED,
    pending: counts.PENDING,
    running: counts.RUNNING,
    cancelled: counts.CANCELLED,
    percent: batch.caseCount === 0 ? 0 : settled / batch.caseCount,
    cancellable: !isTerminalBatchStatus(batch.status),
  };
}

export async function getEvaluationProgress(
  user: AuthUser,
  batchId: string,
): Promise<BatchProgress> {
  const { batch } = await requireBatch(user, batchId);
  return progressFor(batch);
}

export async function listEvaluationCases(
  user: AuthUser,
  batchId: string,
  query: ListCasesQuery,
): Promise<{
  cases: Array<
    EvaluationCaseRecord & { results: EvaluationResultView[]; passed: boolean | null }
  >;
  total: number;
  limit: number;
  offset: number;
}> {
  const { batch } = await requireBatch(user, batchId);
  const page = await evaluationRepository.listCases(batchId, {
    ...(query.status !== undefined && query.status.length > 0 ? { status: query.status } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  });

  // Results for the page's cases in one query, then re-bucketed (no N+1).
  const withResults = await evaluationRepository.listCaseResultsWithResults(
    batchId,
    batch.passThreshold,
  );
  const resultsByKey = new Map(withResults.map((entry) => [entry.caseKey, entry]));

  return {
    cases: page.cases.map((row) => {
      const entry = resultsByKey.get(row.caseKey);
      return {
        ...row,
        results: entry?.results ?? [],
        passed: entry?.passed ?? null,
      };
    }),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  };
}

export async function getEvaluationCase(
  user: AuthUser,
  batchId: string,
  caseKey: string,
): Promise<{
  case: EvaluationCaseRecord;
  results: EvaluationResultView[];
  passed: boolean | null;
  batch: EvaluationBatchRecord;
}> {
  const { batch } = await requireBatch(user, batchId);
  const row = await evaluationRepository.findCase(batchId, caseKey);
  if (row === null) {
    throw new NotFoundError(`Test case "${caseKey}" not found in this batch`);
  }
  const results = await evaluationRepository.listResultsForCase(row.id);
  const aggregate = aggregateResults({
    assignments: batch.evaluatorConfig.map((assignment) => ({
      evaluatorKey: assignment.key,
      weight: assignment.weight,
    })),
    results,
    policy: batch.scoringPolicy,
    passThreshold: batch.passThreshold,
  });
  return { case: row, results, passed: aggregate.passed, batch };
}

/**
 * Cancels a batch: records the durable intent, aborts the in-flight runs (so
 * they stop doing work instead of being relabelled), and settles the batch if
 * nothing is running. When cases *are* running, the orchestrator finalises —
 * which keeps one writer for the terminal state.
 */
export async function cancelEvaluationBatch(
  user: AuthUser,
  batchId: string,
): Promise<{ batch: EvaluationBatchRecord; runningCases: number }> {
  const { batch } = await requireBatch(user, batchId);
  if (isTerminalBatchStatus(batch.status)) {
    throw new EvaluationBatchConflictError(
      `This evaluation is already ${batch.status.toLowerCase()} and cannot be cancelled`,
    );
  }

  await evaluationRepository.requestCancellation(batchId);

  const cases = await evaluationRepository.listCases(batchId, { limit: 200 });
  const running = cases.cases.filter((row) => row.status === "RUNNING" && row.runId !== null);
  for (const row of running) {
    if (row.runId !== null) {
      // The runtime observes this between nodes and inside in-flight calls.
      const { requestRunCancellation } = await import("@/modules/runtime/events/bus");
      await requestRunCancellation(row.runId, `evaluation batch ${batchId} cancelled`);
    }
  }

  const pending = cases.cases.filter((row) => row.status === "PENDING");
  if (running.length === 0) {
    for (const row of pending) {
      await evaluationRepository.completeCase(batchId, row.id, {
        status: "CANCELLED",
        error: { kind: "cancelled", code: "BATCH_CANCELLED", message: "Cancelled before this case started." },
        incrementCompleted: false,
        incrementFailed: false,
      });
    }
    await finalizeBatch(batchId);
  }

  serviceLogger.info("evaluation cancellation requested", {
    batchId,
    userId: user.id,
    runningCases: running.length,
  });
  const refreshed = await evaluationRepository.findById(batchId);
  return { batch: refreshed ?? batch, runningCases: running.length };
}

/**
 * Settles a batch: status + metrics, computed from the case rows themselves so
 * progress can never disagree with the results.
 */
export async function finalizeBatch(batchId: string): Promise<EvaluationBatchRecord | null> {
  const batch = await evaluationRepository.findById(batchId);
  if (batch === null) {
    return null;
  }
  const counts = await evaluationRepository.countsByStatus(batchId);
  const metrics = computeBatchMetrics({
    policy: batch.scoringPolicy,
    cases: await evaluationRepository.listCaseMetricRows(batchId, batch.passThreshold),
  });
  await evaluationRepository.saveMetrics(batchId, metrics);

  const cancelled = batch.cancelRequestedAt !== null;
  const outstanding = counts.PENDING + counts.RUNNING;
  let status = batch.status;
  if (outstanding === 0) {
    if (cancelled) {
      status = "CANCELLED";
    } else if (counts.FAILED > 0 && counts.COMPLETED > 0) {
      status = "PARTIALLY_COMPLETED";
    } else if (counts.FAILED > 0 && counts.COMPLETED === 0) {
      status = "FAILED";
    } else if (counts.COMPLETED > 0) {
      status = "COMPLETED";
    } else {
      status = "FAILED";
    }
  }

  await evaluationRepository.updateStatus(batchId, {
    status,
    completedAt: outstanding === 0 ? new Date() : batch.completedAt,
  });

  const refreshed = await evaluationRepository.findById(batchId);
  serviceLogger.info("evaluation batch settled", {
    batchId,
    status,
    completed: counts.COMPLETED,
    failed: counts.FAILED,
    cancelled: counts.CANCELLED,
    meanScore: metrics.score.mean,
  });
  return refreshed;
}

/** Stored metrics, or freshly computed ones for a batch still in progress. */
export async function getEvaluationMetrics(
  user: AuthUser,
  batchId: string,
): Promise<BatchMetrics> {
  const { batch } = await requireBatch(user, batchId);
  if (batch.metrics !== null) {
    return batch.metrics;
  }
  return computeBatchMetrics({
    policy: batch.scoringPolicy,
    cases: await evaluationRepository.listCaseMetricRows(batchId, batch.passThreshold),
  });
}

// --- comparison --------------------------------------------------------------

function errorCategoriesFromCases(
  cases: Array<{ status: string; results: EvaluationResultView[] }>,
): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const entry of cases) {
    if (entry.status === "FAILED") {
      categories["case_failed"] = (categories["case_failed"] ?? 0) + 1;
    }
    for (const result of entry.results) {
      if (result.status === "ERROR") {
        const key = `evaluator_error:${result.kind}`;
        categories[key] = (categories[key] ?? 0) + 1;
      }
    }
  }
  return categories;
}

async function toComparableBatch(batch: EvaluationBatchRecord): Promise<ComparableBatch> {
  const cases = await evaluationRepository.listCaseResultsWithResults(
    batch.id,
    batch.passThreshold,
  );
  const metrics = await computeBatchMetrics({
    policy: batch.scoringPolicy,
    cases: await evaluationRepository.listCaseMetricRows(batch.id, batch.passThreshold),
  });
  const comparableCases: ComparableCase[] = cases.map((entry) => ({
    caseKey: entry.caseKey,
    name: null,
    status: entry.status,
    aggregateScore: entry.aggregateScore,
    aggregateStatus: (entry.aggregateStatus as ComparableCase["aggregateStatus"]) ?? null,
    passed: entry.passed,
  }));

  return {
    id: batch.id,
    label: batch.label,
    datasetId: batch.datasetId,
    datasetVersionId: batch.datasetVersionId,
    harnessId: batch.harnessId,
    harnessVersionId: batch.harnessVersionId,
    harnessVersionLabel: batch.harnessSnapshot.harnessVersion,
    status: batch.status,
    scoringPolicy: batch.scoringPolicy,
    passThreshold: batch.passThreshold,
    caseCount: batch.caseCount,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    metrics: {
      passRate: metrics.passRate,
      passed: metrics.passed,
      failed: metrics.failed,
      meanScore: metrics.score.mean,
      medianScore: metrics.score.median,
      averageLatencyMs: metrics.latency.averageMs,
      totalTokens: metrics.tokens.total,
      tokenReports: metrics.tokens.reported,
      cost: metrics.cost,
      retries: metrics.retries,
      toolInvocations: metrics.toolInvocations,
      nodeExecutions:
        batch.harnessSnapshot.nodeCount === 0
          ? 0
          : cases.length * batch.harnessSnapshot.nodeCount,
      errorCategories: errorCategoriesFromCases(cases),
    },
    cases: comparableCases,
  };
}

export interface BatchCompareResult extends BatchComparison {
  baselineBatch: EvaluationBatchRecord;
  candidateBatch: EvaluationBatchRecord;
}

export async function compareEvaluationBatches(
  user: AuthUser,
  query: CompareBatchesQuery,
): Promise<BatchCompareResult> {
  if (query.baseline === query.candidate) {
    throw new EvaluationBatchConflictError("Pick two different evaluations to compare");
  }
  const baseline = await requireBatch(user, query.baseline);
  const candidate = await requireBatch(user, query.candidate);

  for (const batch of [baseline.batch, candidate.batch]) {
    if (batch.metrics === null && !isTerminalBatchStatus(batch.status)) {
      throw new EvaluationBatchConflictError(
        "Comparison needs finished evaluations — wait for both batches to complete.",
      );
    }
  }

  let comparison: BatchComparison;
  try {
    comparison = compareBatches(
      await toComparableBatch(baseline.batch),
      await toComparableBatch(candidate.batch),
    );
  } catch (error) {
    if (error instanceof EvaluationComparisonError) {
      throw new EvaluationBatchConflictError(error.message);
    }
    throw error;
  }

  return { ...comparison, baselineBatch: baseline.batch, candidateBatch: candidate.batch };
}

// --- run-level evaluation ----------------------------------------------------

/**
 * Recomputes the aggregate for stored results.
 *
 * Weights come from the batch that produced the results when there is one, and
 * from each result's recorded metadata otherwise. The policy is read back the
 * same way — so what the UI shows for an old evaluation is derived from what
 * was stored, never from today's defaults.
 */
function summarizeStoredResults(
  results: EvaluationResultView[],
  assignments: Array<{ evaluatorKey: string; weight: number }>,
  policy: "REQUIRE_ALL" | "IGNORE_MISSING",
): AggregateScore {
  return aggregateResults({ assignments, results, policy });
}

export async function listRunEvaluations(
  user: AuthUser,
  runId: string,
): Promise<RunEvaluationGroup[]> {
  // Authorizes the caller and proves the run exists.
  await getRunDetail(user, runId);
  const results = await evaluationRepository.listResultsForRun(runId);
  if (results.length === 0) {
    return [];
  }

  const grouped = new Map<string, EvaluationResultView[]>();
  for (const result of results) {
    const key = result.caseResultId ?? `run:${runId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(result);
    grouped.set(key, bucket);
  }

  const batchIds = [
    ...new Set(
      results.map((result) => result.batchId).filter((id): id is string => id !== null),
    ),
  ];
  const batches = new Map<string, EvaluationBatchRecord>();
  for (const batchId of batchIds) {
    const batch = await evaluationRepository.findById(batchId);
    if (batch !== null) {
      batches.set(batchId, batch);
    }
  }

  const groups: RunEvaluationGroup[] = [];
  for (const bucket of grouped.values()) {
    const first = bucket[0];
    if (first === undefined) {
      continue;
    }
    const batch = first.batchId === null ? null : (batches.get(first.batchId) ?? null);
    const caseRow =
      first.caseResultId === null
        ? null
        : await evaluationRepository.getCase(first.caseResultId);

    const assignments =
      batch === null
        ? bucket.map((result) => ({
            evaluatorKey: result.evaluatorKey,
            weight: typeof result.metadata?.["weight"] === "number" ? (result.metadata["weight"] as number) : 0,
          }))
        : batch.evaluatorConfig.map((assignment) => ({
            evaluatorKey: assignment.key,
            weight: assignment.weight,
          }));

    const policy =
      batch?.scoringPolicy ??
      (bucket.some((result) => result.metadata?.["policy"] === "IGNORE_MISSING")
        ? "IGNORE_MISSING"
        : DEFAULT_SCORING_POLICY);

    const aggregate = summarizeStoredResults(bucket, assignments, policy);
    const storedScore = caseRow?.aggregateScore ?? null;
    const storedStatus = caseRow?.aggregateStatus ?? null;

    groups.push({
      batchId: first.batchId,
      batchLabel: batch?.label ?? null,
      caseKey: caseRow?.caseKey ?? null,
      caseStatus: caseRow?.status ?? null,
      runStatus: caseRow === null ? null : (batch?.status ?? null),
      createdAt: first.createdAt,
      aggregate: {
        score: storedScore ?? aggregate.score,
        status: storedStatus ?? aggregate.status,
        passed:
          storedScore !== null && batch?.passThreshold != null
            ? storedScore >= batch.passThreshold
            : aggregate.passed,
        policy,
        explanation: aggregate.explanation,
        missing: aggregate.missing,
        errored: aggregate.errored,
      },
      results: bucket,
    });
  }

  groups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return groups;
}

/**
 * Scores one already-finished run with a chosen set of evaluators.
 *
 * This is the "is this answer good?" action on a run detail page. It does not
 * touch the run: the run's own status and output stay exactly as recorded.
 */
export async function evaluateRun(
  user: AuthUser,
  runId: string,
  body: EvaluateRunBody,
): Promise<RunEvaluationGroup> {
  const detail = await getRunDetail(user, runId);
  if (detail.live) {
    throw new EvaluationBatchConflictError(
      "This run is still executing — evaluate it once it finishes.",
    );
  }

  const assignments = await resolveAssignments(user, body.evaluators);
  const policy = body.scoringPolicy ?? DEFAULT_SCORING_POLICY;
  const observation = await loadRunObservation(runId);

  const results: EvaluationResultRecord[] = [];
  for (const assignment of assignments) {
    const record = await runEvaluator({
      kind: assignment.kind,
      evaluatorKey: `${assignment.evaluatorId}@${assignment.evaluatorVersion}`,
      evaluatorName: assignment.name,
      evaluatorId: assignment.evaluatorId,
      evaluatorVersion: assignment.evaluatorVersion,
      config: assignment.config,
      input: {
        run: observation,
        output: observation.output,
        task: observation.input,
        expectedOutput: null,
        case: null,
      },
      context: {
        runId,
        caseKey: null,
        logger: serviceLogger,
        now: () => new Date(),
        ...(assignment.kind === "llm_judge" ? { llm: { gateway: getLLMGateway() } } : {}),
      },
    });
    results.push(record);
  }

  await evaluationRepository.replaceRunResults(
    runId,
    results.map((result) => ({
      result: {
        ...result,
        metadata: { ...(result.metadata ?? {}), weight: 0, policy },
      },
      weight: 0,
    })),
  );

  const aggregate = aggregateResults({
    assignments: assignments.map((assignment) => ({
      evaluatorKey: `${assignment.evaluatorId}@${assignment.evaluatorVersion}`,
      weight: 0,
    })),
    results,
    policy,
  });

  serviceLogger.info("run evaluated", {
    runId,
    evaluators: results.length,
    score: aggregate.score,
    status: aggregate.status,
    userId: user.id,
  });

  const groups = await listRunEvaluations(user, runId);
  return (
    groups[0] ?? {
      batchId: null,
      batchLabel: null,
      caseKey: null,
      caseStatus: null,
      runStatus: null,
      createdAt: new Date(),
      aggregate,
      results: [],
    }
  );
}

// --- export ------------------------------------------------------------------

export interface EvaluationReport {
  schemaVersion: 1;
  kind: "orqestra.evaluation-report";
  exportedAt: string;
  sanitized: true;
  batch: {
    id: string;
    label: string | null;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    scoringPolicy: string;
    passThreshold: number | null;
    counters: { caseCount: number; completedCount: number; failedCount: number };
  };
  harness: EvaluationBatchRecord["harnessSnapshot"];
  dataset: { id: string; versionId: string; version: number; caseCount: number };
  evaluators: Array<{
    key: string;
    name: string;
    kind: string;
    version: number;
    weight: number;
    usesLlm: boolean;
  }>;
  metrics: BatchMetrics | null;
  /** Cases are capped so an export cannot grow without bound. */
  caseLimit: number;
  truncated: boolean;
  cases: Array<{
    caseKey: string;
    status: string;
    score: number | null;
    aggregateStatus: string | null;
    passed: boolean | null;
    runId: string | null;
    error: unknown;
    results: Array<{
      evaluatorKey: string;
      evaluatorName: string;
      kind: string;
      status: string;
      score: number | null;
      maxScore: number;
      normalizedScore: number | null;
      passed: boolean | null;
      explanation: string;
      durationMs: number;
      evidence: unknown;
      metadata: unknown;
    }>;
  }>;
}

const EXPORT_CASE_LIMIT = 500;

/**
 * Builds the sanitized evaluation report. Every free-form value passes through
 * `sanitizeValue`, so a judge's evidence (which quotes agent output) cannot
 * carry a credential out of the platform.
 */
export async function exportEvaluationReport(
  user: AuthUser,
  batchId: string,
): Promise<EvaluationReport> {
  const { batch } = await requireBatch(user, batchId);
  const cases = await evaluationRepository.listCases(batchId, { limit: EXPORT_CASE_LIMIT });
  const withResults = await evaluationRepository.listCaseResultsWithResults(
    batchId,
    batch.passThreshold,
  );
  const byKey = new Map(withResults.map((entry) => [entry.caseKey, entry]));

  return {
    schemaVersion: 1,
    kind: "orqestra.evaluation-report",
    exportedAt: new Date().toISOString(),
    sanitized: true,
    batch: {
      id: batch.id,
      label: batch.label,
      status: batch.status,
      createdAt: batch.createdAt.toISOString(),
      startedAt: batch.startedAt?.toISOString() ?? null,
      completedAt: batch.completedAt?.toISOString() ?? null,
      scoringPolicy: batch.scoringPolicy,
      passThreshold: batch.passThreshold,
      counters: {
        caseCount: batch.caseCount,
        completedCount: batch.completedCount,
        failedCount: batch.failedCount,
      },
    },
    harness: batch.harnessSnapshot,
    dataset: {
      id: batch.datasetId,
      versionId: batch.datasetVersionId,
      version: (await datasetRepository.findVersionById(batch.datasetVersionId))?.version ?? 0,
      caseCount: batch.datasetSnapshot.length,
    },
    evaluators: batch.evaluatorConfig.map((assignment) => ({
      key: assignment.key,
      name: assignment.name,
      kind: assignment.kind,
      version: assignment.evaluatorVersion,
      weight: assignment.weight,
      usesLlm: assignment.usesLlm,
    })),
    metrics: batch.metrics,
    caseLimit: EXPORT_CASE_LIMIT,
    truncated: batch.caseCount > cases.cases.length,
    cases: cases.cases.map((row) => {
      const entry = byKey.get(row.caseKey);
      return {
        caseKey: row.caseKey,
        status: row.status,
        score: row.aggregateScore,
        aggregateStatus: row.aggregateStatus,
        passed: entry?.passed ?? null,
        runId: row.runId,
        error: sanitizeValue(row.error),
        results: (entry?.results ?? []).map((result) => ({
          evaluatorKey: result.evaluatorKey,
          evaluatorName: result.evaluatorName,
          kind: result.kind,
          status: result.status,
          score: result.score,
          maxScore: result.maxScore,
          normalizedScore: result.normalizedScore,
          passed: result.passed,
          explanation: result.explanation,
          durationMs: result.durationMs,
          evidence: sanitizeValue(result.evidence),
          metadata: sanitizeValue(result.metadata),
        })),
      };
    }),
  };
}

// --- internal helpers used by the API and the orchestrator -------------------

/** Re-runs a single failed case through the same orchestrator path. */
export async function retryEvaluationCase(
  user: AuthUser,
  batchId: string,
  caseKey: string,
): Promise<EvaluationCaseRecord> {
  const { batch } = await requireBatch(user, batchId);
  const row = await evaluationRepository.findCase(batchId, caseKey);
  if (row === null) {
    throw new NotFoundError(`Test case "${caseKey}" not found in this batch`);
  }
  if (row.status !== "FAILED" && row.status !== "CANCELLED") {
    throw new EvaluationBatchConflictError(
      `Only failed or cancelled cases can be retried — this one is ${row.status.toLowerCase()}.`,
    );
  }
  if (isTerminalBatchStatus(batch.status)) {
    // Reopening a settled batch would contradict its stored metrics, so the
    // batch is moved back to RUNNING before the case is retried.
    await evaluationRepository.updateStatus(batchId, { status: "RUNNING", completedAt: null });
  }
  await evaluationRepository.resetCaseForRetry(batchId, caseKey);
  await runEvaluationBatch(batchId, { transport: "inline", onlyCaseKey: caseKey });
  const refreshed = await evaluationRepository.findCase(batchId, caseKey);
  return refreshed ?? row;
}
