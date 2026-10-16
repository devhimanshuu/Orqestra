/**
 * The optimization loop.
 *
 *   analyze → hypothesize → select → mutate → validate → evaluate → compare →
 *   decide → record → repeat, until a stop condition fires.
 *
 * Reliability rules, all deliberate and all mirrored from the experiment engine:
 *
 *  - **One pass owns the session.** The session is claimed QUEUED → RUNNING with
 *    a conditional update; a redelivered job claims nothing and returns.
 *  - **Every step is checkpointed.** Findings, hypotheses, candidates, their
 *    change sets, decisions and events are rows before the next step runs, so a
 *    crashed worker leaves a state another pass can continue from.
 *  - **The loop is bounded before it starts.** Iteration, candidate, run, token,
 *    cost and wall-clock ceilings are checked before each iteration and before
 *    each candidate's evaluation — never inside the UI.
 *  - **Cancellation is observed, not simulated.** The durable flag is read
 *    between iterations, between candidates and between cases.
 *  - **The baseline is read-only.** Mutations are applied to a structural clone;
 *    candidate versions are *new* rows; `Harness.currentVersion` is never written
 *    here. Promotion is a separate, explicitly authorized action.
 *  - **No silent retries.** A hypothesis whose proposal is rejected is marked
 *    exhausted, and an identical candidate is never rebuilt (fingerprint).
 */

import { logger } from "@/lib/logging/logger";
import type { BatchMetrics } from "@/modules/evaluation/metrics";
import { evaluationRepository } from "@/modules/evaluation/evaluation.repository";
import { finalizeBatch } from "@/modules/evaluation/evaluation.service";
import { runEvaluationCaseJob } from "@/modules/evaluation/jobs/orchestrator";
import type { HarnessSnapshot } from "@/modules/evaluation/batch.types";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { validateHarnessDefinition } from "@/modules/harness/harness.validation";
import { hashHarnessDefinition } from "@/modules/harness/harness.serialize";
import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import { analyzeFailures, type FindingDraft } from "../analysis/failure-analysis";
import { analyzeSemantically } from "../analysis/llm-analysis";
import { generateHypotheses } from "../hypotheses/generate";
import { generateLlmHypotheses } from "../hypotheses/llm-generate";
import { hypothesisFingerprint } from "../hypotheses/fingerprint";
import { applyMutations, mutationFingerprint } from "../mutations/apply";
import { validateCandidate } from "../validation/candidate-validation";
import { evaluateAcceptance, readBatchMetric } from "../policies/acceptance";
import { evaluateStopping, fitsRunBudget } from "../policies/stopping";
import { rankOptimizationCandidates } from "../scoring/ranking";
import { buildOptimizationReport } from "../reporting/report";
import { proposeForHypothesis } from "../strategies/registry";
import { optimizationRepository } from "../optimization.repository";
import { settleOptimizationStatus } from "../optimization.lifecycle";
import type {
  FailureFindingRecord,
  ImprovementHypothesisRecord,
  TerminalOptimizationStatus,
  OptimizationCandidateRecord,
  OptimizationConfigSnapshot,
  OptimizationSessionRecord,
  OptimizationStatus,
  StopReason,
} from "../optimization.types";

const orchestratorLogger = logger.child({ module: "optimization.orchestrator" });

/** Attempts per candidate case, including the first — the experiment default. */
const CANDIDATE_CASE_ATTEMPTS = 2;

export interface RunOptimizationOptions {
  transport: "queue" | "inline" | "unknown";
  nonce?: string;
}

export interface OptimizationRunSummary {
  sessionId: string;
  claimed: boolean;
  status: string | undefined;
  iterations: number;
  candidatesCreated: number;
  candidatesEvaluated: number;
  accepted: number;
  rejected: number;
  invalid: number;
  skippedDuplicates: number;
  runsCreated: number;
  stopReason: StopReason | null;
  /** Set when the loop parked for human approval. */
  awaitingReview: boolean;
}

const EMPTY_SUMMARY: Omit<OptimizationRunSummary, "sessionId"> = {
  claimed: false,
  status: undefined,
  iterations: 0,
  candidatesCreated: 0,
  candidatesEvaluated: 0,
  accepted: 0,
  rejected: 0,
  invalid: 0,
  skippedDuplicates: 0,
  runsCreated: 0,
  stopReason: null,
  awaitingReview: false,
};

/**
 * Reads the session's counters back from rows. Never from memory: a crashed pass
 * must leave numbers the next pass can trust.
 */
async function refreshCounters(sessionId: string): Promise<{
  runCount: number;
  candidates: OptimizationCandidateRecord[];
  candidatesCreated: number;
  tokenUsage: number;
  estimatedCostUsd: number;
  analyzerTokenUsage: number;
}> {
  const candidates = await optimizationRepository.listCandidates(sessionId);
  const runCount = await optimizationRepository.countSessionRuns(sessionId);
  // Analyzer tokens are a session-level aggregate, not a sum over candidates:
  // the analysis pass spends tokens before any candidate exists, and a proposal
  // that never becomes a candidate still had to be paid for. The column is
  // incremented at the point of spend, so it is read back rather than recomputed.
  const analyzerTokenUsage =
    (await optimizationRepository.findById(sessionId))?.analyzerTokenUsage ?? 0;
  let tokenUsage = 0;
  let estimatedCostUsd = 0;
  for (const candidate of candidates) {
    const metrics: BatchMetrics | null = candidate.metrics;
    if (metrics !== null) {
      tokenUsage += metrics.tokens.total;
      estimatedCostUsd += metrics.cost.costUsd ?? 0;
    }
  }
  return {
    runCount,
    candidates,
    candidatesCreated: candidates.length,
    tokenUsage,
    estimatedCostUsd,
    analyzerTokenUsage,
  };
}

/** Builds the immutable configuration snapshot the session is sealed with. */
export function buildConfigSnapshot(input: {
  session: OptimizationSessionRecord;
  baseline: {
    harnessId: string;
    harnessVersionId: string;
    harnessVersion: number;
    contentHash: string;
    entryNode: string;
    nodeCount: number;
    edgeCount: number;
  };
  sourceBatch: {
    batchId: string;
    status: string;
    caseCount: number;
    completedCount: number;
    failedCount: number;
    metrics: BatchMetrics | null;
  };
  dataset: { id: string; versionId: string; version: number; caseCount: number };
}): OptimizationConfigSnapshot {
  return {
    schemaVersion: 1,
    scoringPolicy: input.session.scoringPolicy,
    passThreshold: input.session.passThreshold,
    objective: input.session.objective,
    constraints: input.session.constraints,
    limits: input.session.limits,
    strategy: input.session.strategy,
    baseline: input.baseline,
    sourceBatch: input.sourceBatch,
    dataset: input.dataset,
    evaluators: input.session.evaluatorConfig,
    reproducibilityNotes: [
      "Candidates are new immutable harness versions published from a mutated copy of the baseline definition.",
      "Every candidate is evaluated over the source batch's own dataset snapshot and evaluator revisions, so the comparison is like-for-like.",
      "Cost is an estimate derived from the pricing table; token totals cover only the runs that reported usage.",
    ],
  };
}

/**
 * Publishes a candidate as a new immutable harness version.
 *
 * `harnessRepository.createNextVersion` is used directly (not the harness
 * service) because this runs in a worker without an HTTP user: the session's
 * `createdBy` is recorded as the author, and the service's authorization was
 * already enforced when the session was created. The harness's draft and its
 * `currentVersion` are untouched.
 */
async function publishCandidateVersion(input: {
  harnessId: string;
  harnessName: string;
  harnessSlug: string;
  /** The mutated definition (untrusted shape until it validates here). */
  definition: unknown;
  releaseNotes: string;
  createdBy: string | null;
}): Promise<{
  id: string;
  version: number;
  contentHash: string;
  entryNode: string;
  nodeCount: number;
  edgeCount: number;
}> {
  const latest = await harnessRepository.findLatestVersion(input.harnessId);
  const version = (latest?.version ?? 0) + 1;
  // Stamp the envelope (id = the harness slug, version = the next number), then
  // validate — publishing is the last gate before a version exists.
  const stamped = {
    ...(input.definition as Record<string, unknown>),
    id: input.harnessSlug,
    version,
  };
  const validated = validateHarnessDefinition(stamped);
  if (!validated.ok || validated.definition === null) {
    throw new Error(
      `Candidate definition failed validation at publish time: ${validated.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const definition = validated.definition;
  const contentHash = hashHarnessDefinition(definition);
  const record = await harnessRepository.createNextVersion({
    harnessId: input.harnessId,
    version,
    name: input.harnessName,
    definition,
    contentHash,
    entryNode: definition.entryNode,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    releaseNotes: input.releaseNotes,
    // Workers run without an HTTP user; a null author is omitted rather than
    // invented.
    ...(input.createdBy === null ? {} : { createdBy: input.createdBy }),
  });
  return {
    id: record.id,
    version: record.version,
    contentHash,
    entryNode: record.entryNode,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
  };
}

/**
 * What one proposal step produced.
 *
 * The long proposal path (hypothesis → operations → mutation → validation →
 * candidate row) lives in this helper so the loop body stays a readable sequence
 * of decisions: resume an approved candidate, or propose a new one, then evaluate
 * whichever came out.
 */
type CandidateProposalOutcome =
  | {
      kind: "candidate";
      candidate: OptimizationCandidateRecord;
      hypothesisId: string;
      definition: unknown;
      label: string;
    }
  | { kind: "no_hypotheses" }
  /** Nothing runnable came out; `invalid` counts toward the invalid budget. */
  | { kind: "skipped"; invalid: boolean; duplicate: boolean };

async function proposeNextCandidate(input: {
  sessionId: string;
  iteration: number;
  hypotheses: ImprovementHypothesisRecord[];
  findings: FailureFindingRecord[];
  baselineDefinition: HarnessDefinition;
  baselineContentHash: string;
  current: OptimizationSessionRecord;
}): Promise<CandidateProposalOutcome> {
  const hypothesis = input.hypotheses.find((entry) => entry.status === "PROPOSED");
  if (hypothesis === undefined) {
    return { kind: "no_hypotheses" };
  }
  await optimizationRepository.setHypothesisStatus(hypothesis.id, "SELECTED");

  // --- propose operations (typed, validated downstream) -----------------------
  const proposal = await proposeForHypothesis({
    hypothesis,
    findings: input.findings,
    definition: input.baselineDefinition,
    objective: input.current.objective,
    evaluatorConfig: input.current.evaluatorConfig,
    limits: input.current.limits,
    sessionStrategy: input.current.strategy,
  });

  if (proposal.usage.totalTokens > 0) {
    const refreshed = await refreshCounters(input.sessionId);
    await optimizationRepository.setCounters(input.sessionId, {
      analyzerTokenUsage: refreshed.analyzerTokenUsage + proposal.usage.totalTokens,
    });
  }

  if (!proposal.ok) {
    await optimizationRepository.setHypothesisStatus(hypothesis.id, "EXHAUSTED");
    await optimizationRepository.appendEvent({
      sessionId: input.sessionId,
      kind: "hypothesis.exhausted",
      message: `No runnable change derived from "${hypothesis.title}": ${proposal.reason ?? "unknown reason"}.`,
      ref: hypothesis.id,
    });
    return { kind: "skipped", invalid: true, duplicate: false };
  }

  // --- mutate (the baseline is only ever read) --------------------------------
  const application = applyMutations(input.baselineDefinition, proposal.operations);
  if (application.applied.length === 0) {
    await optimizationRepository.setHypothesisStatus(hypothesis.id, "EXHAUSTED");
    await optimizationRepository.appendEvent({
      sessionId: input.sessionId,
      kind: "candidate.rejected",
      message: `Every proposed change was refused: ${application.rejected.map((entry) => `${entry.target} — ${entry.reason}`).join("; ")}`,
      ref: hypothesis.id,
    });
    return { kind: "skipped", invalid: true, duplicate: false };
  }

  const fingerprint = mutationFingerprint(input.baselineContentHash, application.applied);
  const duplicate = await optimizationRepository.findCandidateByFingerprint(input.sessionId, fingerprint);
  if (duplicate !== null) {
    await optimizationRepository.setHypothesisStatus(hypothesis.id, "EXHAUSTED");
    await optimizationRepository.appendEvent({
      sessionId: input.sessionId,
      kind: "candidate.deduplicated",
      message: "An identical candidate already exists; not re-evaluating it.",
      ref: duplicate.id,
    });
    return { kind: "skipped", invalid: false, duplicate: true };
  }

  const validation = validateCandidate({
    definition: application.definition,
    changes: application.applied,
    baselineEntryNode: input.baselineDefinition.entryNode,
    baselineExitNodes: input.baselineDefinition.exitNodes,
  });

  const label = `${hypothesis.title.slice(0, 60)} (i${input.iteration})`;
  const candidate = await optimizationRepository.createCandidate({
    sessionId: input.sessionId,
    iteration: input.iteration,
    hypothesisId: hypothesis.id,
    label,
    fingerprint,
    status: validation.ok ? "PROPOSED" : "INVALID",
    validation,
    changeSet: application.applied,
    // Persisted immediately: an approved candidate must survive a restart, and
    // this is the exact definition the reviewer approved.
    pendingDefinition: application.definition,
    analyzerTokenUsage: proposal.usage.totalTokens,
  });
  await optimizationRepository.addMutations(candidate.id, application.applied);
  await optimizationRepository.appendEvent({
    sessionId: input.sessionId,
    kind: validation.ok ? "candidate.created" : "candidate.invalid",
    message: validation.ok
      ? `Candidate "${label}" created from ${application.applied.length} typed change${application.applied.length === 1 ? "" : "s"}.`
      : `Candidate "${label}" failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`,
    ref: candidate.id,
    payload: {
      risk: application.applied.map((change) => change.risk),
      rejected: application.rejected,
    },
  });

  if (!validation.ok) {
    await optimizationRepository.recordDecision({
      sessionId: input.sessionId,
      candidateId: candidate.id,
      kind: "REJECT",
      rationale: {
        stage: "validation",
        issues: validation.issues,
        reasons: [
          "The candidate never reached execution because its graph or configuration is invalid.",
        ],
      },
      actor: "system",
    });
    await optimizationRepository.updateCandidate(candidate.id, {
      decisionKind: "REJECT",
      // Keep the definition: an auditor can still inspect exactly what was
      // refused, and the row no longer qualifies as an approved candidate.
      clearPendingDefinition: true,
    });
    return { kind: "skipped", invalid: true, duplicate: false };
  }

  return { kind: "candidate", candidate, hypothesisId: hypothesis.id, definition: application.definition, label };
}

/**
 * Runs the opt-in LLM-assisted analysis pass.
 *
 * One job: turn the deterministic findings into *labelled* hypotheses about the
 * pattern behind them. Nothing it returns is trusted beyond what the rules
 * already saw — a claim about a case the deterministic pass never observed is
 * dropped before it is stored — and a model that cannot answer records an event
 * instead of failing the session.
 */
async function runSemanticPass(input: {
  sessionId: string;
  batchId: string;
  analyzerModel: string | null;
  drafts: readonly FindingDraft[];
}): Promise<{ findings: FindingDraft[] }> {
  if (input.analyzerModel === null || input.drafts.length === 0) {
    return { findings: [] };
  }
  const observedCaseKeys = [...new Set(input.drafts.flatMap((draft) => draft.caseKeys))];
  const result = await analyzeSemantically({
    sessionId: input.sessionId,
    batchId: input.batchId,
    analyzerModel: input.analyzerModel,
    findings: input.drafts,
    observedCaseKeys,
  });
  if (result.usage !== null) {
    await optimizationRepository.addAnalyzerUsage(input.sessionId, result.usage.totalTokens);
  }
  await optimizationRepository.appendEvent({
    sessionId: input.sessionId,
    kind: "analysis.semantic",
    message:
      result.error !== null
        ? `LLM-assisted analysis was skipped: ${result.error}`
        : result.findings.length === 0
          ? `The analyzer model ${input.analyzerModel} added no pattern beyond the deterministic rules.`
          : `The analyzer model ${input.analyzerModel} added ${result.findings.length} pattern(s), each stored as a hypothesis to be confirmed against the cases it names.`,
    payload: {
      model: input.analyzerModel,
      added: result.findings.length,
      analyzerTokens: result.usage?.totalTokens ?? 0,
      confidence: "llm",
    },
  });
  return { findings: result.findings };
}

/**
 * Runs the bounded optimization loop for one session.
 *
 * Returns a summary; it never throws for an expected condition (a cancelled
 * session, a spent budget, an exhausted hypothesis set) — those are outcomes, and
 * they are recorded as such.
 */
export async function runOptimizationJob(
  sessionId: string,
  options: RunOptimizationOptions,
): Promise<OptimizationRunSummary> {
  const summary: OptimizationRunSummary = { sessionId, ...EMPTY_SUMMARY };

  const record = await optimizationRepository.findById(sessionId);
  if (record === null) {
    return summary;
  }
  if (
    record.status === "COMPLETED" ||
    record.status === "PARTIALLY_COMPLETED" ||
    record.status === "FAILED" ||
    record.status === "CANCELLED"
  ) {
    orchestratorLogger.info("optimization session is already settled", {
      sessionId,
      status: record.status,
    });
    return { ...summary, status: record.status };
  }

  if (record.cancelRequestedAt !== null) {
    await optimizationRepository.updateStatus(sessionId, {
      status: "CANCELLED",
      completedAt: new Date(),
      stopReason: "cancelled",
    });
    await optimizationRepository.appendEvent({
      sessionId,
      kind: "session.cancelled",
      message: "Cancelled before this pass started.",
    });
    return { ...summary, status: "CANCELLED", stopReason: "cancelled" };
  }

  const claimed = await optimizationRepository.claimForRun(sessionId);
  if (!claimed) {
    orchestratorLogger.info("optimization session is not claimable — skipping this pass", {
      sessionId,
      status: record.status,
    });
    return summary;
  }
  summary.claimed = true;

  await optimizationRepository.appendEvent({
    sessionId,
    kind: "pass.started",
    message: `A worker pass started (${options.transport}).`,
    payload: { nonce: options.nonce ?? null },
  });

  // --- evidence and baseline ---------------------------------------------------
  const source = await optimizationRepository.loadSourceBatch(record.sourceBatchId);
  if (source === null) {
    await settle(sessionId, {
      status: "FAILED",
      reason: "infrastructure_failure",
      note: "The source evaluation batch could not be read.",
      summary,
    });
    return { ...summary, status: "FAILED", stopReason: "infrastructure_failure" };
  }

  const baselineVersion = await harnessRepository.findVersionById(record.baselineVersionId);
  const harness = await harnessRepository.findById(record.harnessId);
  if (baselineVersion === null || harness === null) {
    await settle(sessionId, {
      status: "FAILED",
      reason: "infrastructure_failure",
      note: "The baseline harness version could not be read.",
      summary,
    });
    return { ...summary, status: "FAILED", stopReason: "infrastructure_failure" };
  }

  const baselineMetrics = source.batch.metrics;
  const baselineDefinition = baselineVersion.definition;

  // The snapshot is normally written when the session is started; a session that
  // reached a worker without one is sealed here so the audit trail stays complete.
  if (record.configSnapshot === null) {
    const snapshot = buildConfigSnapshot({
      session: record,
      baseline: {
        harnessId: harness.id,
        harnessVersionId: baselineVersion.id,
        harnessVersion: baselineVersion.version,
        contentHash: baselineVersion.contentHash,
        entryNode: baselineVersion.entryNode,
        nodeCount: baselineDefinition.nodes.length,
        edgeCount: baselineDefinition.edges.length,
      },
      sourceBatch: {
        batchId: source.batch.id,
        status: source.batch.status,
        caseCount: source.batch.caseCount,
        completedCount: source.batch.caseCount,
        failedCount: 0,
        metrics: baselineMetrics,
      },
      dataset: {
        id: source.batch.datasetId,
        versionId: source.batch.datasetVersionId,
        version: source.batch.datasetVersion,
        caseCount: source.batch.datasetSnapshot.length,
      },
    });
    await optimizationRepository.sealSession({
      sessionId,
      snapshot,
      status: "RUNNING",
      startedAt: record.startedAt ?? new Date(),
    });
  }

  // --- analysis (once) ---------------------------------------------------------
  let findings = await optimizationRepository.listFindings(sessionId);
  if (findings.length === 0) {
    const drafts = analyzeFailures({
      sessionId,
      batchId: source.batch.id,
      passThreshold: source.batch.passThreshold,
      evaluatorConfig: source.batch.evaluatorConfig,
      cases: source.cases,
      metrics: baselineMetrics,
    });

    // Optional LLM-assisted pass. It reads the deterministic findings and can
    // only add *hypothesis-level* patterns (each stored with confidence "llm");
    // its tokens are accounted against the session's analyzer budget, and a
    // model that is unavailable simply leaves the deterministic analysis intact.
    const semantic = await runSemanticPass({
      sessionId,
      batchId: source.batch.id,
      analyzerModel: record.limits.analyzerModel,
      drafts,
    });

    findings = await optimizationRepository.replaceFindings(sessionId, [
      ...drafts,
      ...semantic.findings,
    ]);
    await optimizationRepository.appendEvent({
      sessionId,
      kind: "analysis.completed",
      message:
        findings.length === 0
          ? "Failure analysis found no weaknesses in the source evaluation."
          : `Failure analysis found ${findings.length} weakness${findings.length === 1 ? "" : "es"}.`,
      payload: { categories: findings.map((finding) => finding.category) },
    });
    if (findings.length === 0) {
      await settle(sessionId, {
        status: "COMPLETED",
        reason: "no_failures_found",
        note: "The source evaluation showed no failures to work on.",
        summary,
      });
      return { ...summary, status: "COMPLETED", stopReason: "no_failures_found" };
    }
  }

  // --- hypotheses (once) -------------------------------------------------------
  let hypotheses = await optimizationRepository.listHypotheses(sessionId);
  if (hypotheses.length === 0) {
    // Rules always run: they are the reproducible floor every session gets,
    // and the fallback when the analyzer model is unavailable.
    const ruleProposals = generateHypotheses({
      findings,
      definition: baselineDefinition,
      objective: record.objective,
      evaluatorConfig: record.evaluatorConfig,
      origin: "RULE_BASED",
    }).map((proposal) => ({ ...proposal, fingerprint: hypothesisFingerprint(proposal) }));

    // LLM sessions additionally ask the model for hypotheses. Its output is
    // fenced (real finding ids only, taxonomy only, low confidence) and a model
    // that cannot answer leaves the rule proposals untouched.
    let proposals = ruleProposals;
    if (record.strategy === "LLM_ASSISTED") {
      const generated = await generateLlmHypotheses({
        sessionId,
        analyzerModel: record.limits.analyzerModel,
        findings,
        definition: baselineDefinition,
        objective: record.objective,
        evaluatorConfig: record.evaluatorConfig,
      });
      if (generated.usage !== null) {
        await optimizationRepository.addAnalyzerUsage(sessionId, generated.usage.totalTokens);
      }
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "hypothesis.llm",
        message:
          generated.error !== null
            ? `LLM-assisted hypothesis generation was skipped: ${generated.error}`
            : generated.hypotheses.length === 0
              ? `The analyzer model proposed no hypothesis beyond the deterministic rules.`
              : `The analyzer model proposed ${generated.hypotheses.length} hypothesis(s), each fenced to the stored findings.`,
        payload: {
          model: record.limits.analyzerModel,
          added: generated.hypotheses.length,
          analyzerTokens: generated.usage?.totalTokens ?? 0,
        },
      });
      if (generated.hypotheses.length > 0) {
        // Model hypotheses lead (that is what the strategy means); the rules
        // follow as the guaranteed floor.
        proposals = [
          ...generated.hypotheses.map((proposal) => ({
            ...proposal,
            fingerprint: hypothesisFingerprint(proposal),
          })),
          ...ruleProposals,
        ];
      }
    }

    const { created, skipped } = await optimizationRepository.createHypotheses(sessionId, proposals);
    for (const hypothesis of created) {
      if (hypothesis.findingId !== null) {
        await optimizationRepository.attachHypothesisToFinding(hypothesis.findingId, hypothesis.id);
      }
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "hypothesis.proposed",
        message: hypothesis.title,
        ref: hypothesis.id,
        payload: { category: hypothesis.category, confidence: hypothesis.confidence },
      });
    }
    orchestratorLogger.info("hypotheses generated", {
      sessionId,
      created: created.length,
      skipped: skipped.length,
    });
    hypotheses = await optimizationRepository.listHypotheses(sessionId);
    if (hypotheses.length === 0) {
      await settle(sessionId, {
        status: "COMPLETED",
        reason: "no_hypotheses",
        note: "No hypothesis could be derived from the findings.",
        summary,
      });
      return { ...summary, status: "COMPLETED", stopReason: "no_hypotheses" };
    }
  }

  // --- the loop ----------------------------------------------------------------
  let iteration = record.currentIteration;
  let consecutiveInvalid = 0;
  let stallIterations = 0;
  let stopReason: StopReason | null = null;
  let cancelled = false;
  let awaitingReview = false;
  let infraFailure: string | null = null;
  const startedAt = record.startedAt ?? new Date();

  for (;;) {
    const current = await optimizationRepository.findById(sessionId);
    if (current === null) {
      infraFailure = "The session disappeared during the pass.";
      break;
    }
    if (current.cancelRequestedAt !== null) {
      cancelled = true;
      stopReason = "cancelled";
      break;
    }

    const counters = await refreshCounters(sessionId);
    const verdict = evaluateStopping({
      limits: current.limits,
      iterationsCompleted: iteration,
      candidateCount: counters.candidatesCreated,
      runCount: counters.runCount,
      tokenUsage: counters.tokenUsage,
      estimatedCostUsd: counters.estimatedCostUsd,
      elapsedMs: Date.now() - startedAt.getTime(),
      consecutiveInvalid,
      stallIterations,
      remainingHypotheses: hypotheses.filter((hypothesis) => hypothesis.status === "PROPOSED").length,
      cancelRequested: false,
    });
    if (verdict.stop) {
      stopReason = verdict.reason;
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "session.stopping",
        message: `Stopping: ${verdict.reason}`,
        payload: { notes: verdict.notes },
      });
      break;
    }

    iteration += 1;
    await optimizationRepository.setCounters(sessionId, { currentIteration: iteration });
    await optimizationRepository.appendEvent({
      sessionId,
      kind: "iteration.started",
      message: `Iteration ${iteration} started (${verdict.notes.length === 0 ? "within limits" : verdict.notes.join(" ")}).`,
      payload: { iteration, candidateCount: counters.candidatesCreated, runCount: counters.runCount },
    });

    // --- resume an approved candidate before proposing anything new -----------
    let candidate: OptimizationCandidateRecord;
    let hypothesisId: string | null;
    let definition: unknown;
    let label: string;
    let humanApproved = false;

    const approvedCandidate = await optimizationRepository.findApprovedCandidateAwaitingEvaluation(
      sessionId,
    );
    if (approvedCandidate !== null) {
      // A reviewer already accepted this candidate's change set. Continue with the
      // very definition they approved rather than deriving a new proposal, so an
      // approval can never be lost to a restart.
      candidate = approvedCandidate;
      hypothesisId = approvedCandidate.hypothesisId;
      definition = approvedCandidate.pendingDefinition;
      label = approvedCandidate.label;
      humanApproved = true;
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "iteration.resumed",
        message: `Iteration ${iteration} continues the approved candidate "${label}".`,
        ref: candidate.id,
      });
    } else {
      const proposal = await proposeNextCandidate({
        sessionId,
        iteration,
        // Re-read before every iteration: the pass must select the next hypothesis
        // the loop has not consumed, not the snapshot it loaded at the start.
        hypotheses: await optimizationRepository.listHypotheses(sessionId),
        findings,
        baselineDefinition,
        baselineContentHash: baselineVersion.contentHash,
        current,
      });
      if (proposal.kind === "no_hypotheses") {
        stopReason = "no_hypotheses";
        break;
      }
      if (proposal.kind === "skipped") {
        if (proposal.duplicate) {
          summary.skippedDuplicates += 1;
        }
        if (proposal.invalid) {
          consecutiveInvalid += 1;
        }
        continue;
      }
      candidate = proposal.candidate;
      hypothesisId = proposal.hypothesisId;
      definition = proposal.definition;
      label = proposal.label;
      summary.candidatesCreated += 1;
      consecutiveInvalid = 0;
    }

    // --- human review gate ----------------------------------------------------
    if (!humanApproved && current.limits.requireApprovalBeforeEvaluation) {
      const decisions = await optimizationRepository.listDecisions(sessionId);
      const approved = decisions.some(
        (decision) =>
          decision.candidateId === candidate.id &&
          decision.actor !== "system" &&
          decision.kind === "ACCEPT",
      );
      if (!approved) {
        awaitingReview = true;
        stopReason = "awaiting_review";
        // The validated definition is already on the row, so approving it in the
        // UI is enough for the next pass to publish and evaluate exactly this.
        await optimizationRepository.updateStatus(sessionId, { status: "WAITING_FOR_REVIEW" });
        await optimizationRepository.appendEvent({
          sessionId,
          kind: "approval.requested",
          message: `Review requested before evaluating "${label}".`,
          ref: candidate.id,
        });
        break;
      }
    }

    if (definition === null || definition === undefined) {
      infraFailure = `Candidate "${label}" carries no definition to publish.`;
      break;
    }

    if (!fitsRunBudget({ runCount: counters.runCount, maxRuns: current.limits.maxRuns, plannedCases: source.batch.datasetSnapshot.length })) {
      stopReason = "max_runs";
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "session.stopping",
        message: `Stopping: evaluating "${label}" would exceed the run budget (${current.limits.maxRuns}).`,
      });
      break;
    }

    // --- publish the candidate version and evaluate it -------------------------
    // A manually attached candidate already *has* its immutable version, so it is
    // measured as published; a proposed one is published here, once.
    let version: {
      id: string;
      version: number;
      contentHash: string;
      entryNode: string;
      nodeCount: number;
      edgeCount: number;
    };
    if (candidate.versionId !== null) {
      const existing = await harnessRepository.findVersionById(candidate.versionId);
      if (existing === null) {
        infraFailure = `Candidate "${label}" points at harness version ${candidate.versionId}, which no longer exists.`;
        break;
      }
      version = {
        id: existing.id,
        version: existing.version,
        contentHash: existing.contentHash,
        entryNode: existing.entryNode,
        nodeCount: existing.definition.nodes.length,
        edgeCount: existing.definition.edges.length,
      };
    } else {
      version = await publishCandidateVersion({
        harnessId: harness.id,
        harnessName: harness.name,
        harnessSlug: harness.slug,
        definition,
        releaseNotes: `Optimization ${sessionId} · iteration ${iteration} · ${hypothesisId ?? label}`,
        createdBy: current.createdBy,
      });
    }
    await optimizationRepository.updateCandidate(candidate.id, {
      versionId: version.id,
      contentHash: version.contentHash,
    });

    const harnessSnapshot: HarnessSnapshot = {
      harnessId: harness.id,
      harnessVersionId: version.id,
      harnessVersion: version.version,
      harnessName: harness.name,
      contentHash: version.contentHash,
      entryNode: version.entryNode,
      nodeCount: version.nodeCount,
      edgeCount: version.edgeCount,
    };
    const batch = await evaluationRepository.createBatch({
      projectId: source.batch.projectId,
      label: `Optimization ${sessionId} · ${label}`,
      agentId: source.batch.agentId,
      harnessId: harness.id,
      harnessVersionId: version.id,
      datasetId: source.batch.datasetId,
      datasetVersionId: source.batch.datasetVersionId,
      datasetSnapshot: source.batch.datasetSnapshot,
      evaluatorConfig: source.batch.evaluatorConfig,
      harnessSnapshot,
      scoringPolicy: source.batch.scoringPolicy,
      passThreshold: source.batch.passThreshold,
      config: { concurrency: 1, limits: null },
      createdBy: current.createdBy,
    });
    await optimizationRepository.updateCandidate(candidate.id, {
      status: "EVALUATING",
      evaluationBatchId: batch.id,
    });
    await optimizationRepository.appendEvent({
      sessionId,
      kind: "evaluation.started",
      message: `Evaluating "${label}" over ${source.batch.datasetSnapshot.length} cases (batch ${batch.id}).`,
      ref: batch.id,
      payload: { harnessVersionId: version.id, batchId: batch.id },
    });

    for (const sample of source.batch.datasetSnapshot) {
      const fresh = await optimizationRepository.findById(sessionId);
      if (fresh?.cancelRequestedAt !== null) {
        cancelled = true;
        stopReason = "cancelled";
        break;
      }
      await runEvaluationCaseJob(batch.id, sample.caseKey, { maxAttempts: CANDIDATE_CASE_ATTEMPTS });
    }

    await finalizeBatch(batch.id);
    const settledBatch = await evaluationRepository.findById(batch.id);
    const candidateMetrics = await optimizationRepository.loadBatchMetrics(batch.id);

    const decision = evaluateAcceptance({
      objective: current.objective,
      constraints: current.constraints,
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      plannedCases: source.batch.datasetSnapshot.length,
      batchStatus: settledBatch?.status ?? "UNKNOWN",
      baselineScoredCases: baselineMetrics?.scored ?? 0,
    });

    await optimizationRepository.updateCandidate(candidate.id, {
      status: candidateMetrics === null ? "FAILED" : "EVALUATED",
      metrics: candidateMetrics,
      baselineMetrics,
      decision,
      decisionKind: decision.kind,
      // The candidate is published and measured now; the review copy is spent.
      clearPendingDefinition: true,
    });
    if (hypothesisId !== null) {
      await optimizationRepository.setHypothesisStatus(hypothesisId, "EXHAUSTED");
    }
    await optimizationRepository.recordDecision({
      sessionId,
      candidateId: candidate.id,
      kind: decision.kind,
      rationale: decision,
      actor: "system",
    });
    await optimizationRepository.appendEvent({
      sessionId,
      kind: `candidate.${decision.kind.toLowerCase()}`,
      message: `${label}: ${decision.kind} — ${decision.reasons[0] ?? "no reason recorded"}`,
      ref: candidate.id,
      payload: {
        evidenceStrength: decision.evidenceStrength,
        evidenceCompleteness: decision.evidenceCompleteness,
        scoredCases: decision.scoredCases,
        violations: decision.violations.map((violation) => violation.constraint),
      },
    });

    summary.candidatesEvaluated += 1;
    if (decision.kind === "ACCEPT") {
      summary.accepted += 1;
      stallIterations = 0;
    } else if (decision.kind === "REJECT") {
      summary.rejected += 1;
      stallIterations += 1;
    } else {
      summary.rejected += 1;
      stallIterations += 1;
    }

    // --- recommendation -------------------------------------------------------
    const after = await refreshCounters(sessionId);
    const ranking = rankOptimizationCandidates({
      objective: current.objective,
      baseline: baselineMetrics,
      candidates: after.candidates.map((entry) => ({
        id: entry.id,
        label: entry.label,
        status: entry.status,
        decisionKind: entry.decisionKind,
        metrics: entry.metrics,
      })),
    });
    await optimizationRepository.setBestCandidate(sessionId, ranking.leader?.candidateId ?? null);
    await optimizationRepository.setCounters(sessionId, {
      currentIteration: iteration,
      candidateCount: after.candidatesCreated,
      runCount: after.runCount,
      tokenUsage: after.tokenUsage,
      estimatedCostUsd: after.estimatedCostUsd,
      analyzerTokenUsage: after.analyzerTokenUsage,
    });
    summary.runsCreated = after.runCount;

    if (cancelled) {
      break;
    }
  }

  // --- settle ------------------------------------------------------------------
  const finalCounters = await refreshCounters(sessionId);
  summary.iterations = (await optimizationRepository.findById(sessionId))?.currentIteration ?? iteration;
  summary.runsCreated = finalCounters.runCount;

  if (awaitingReview) {
    summary.awaitingReview = true;
    summary.stopReason = "awaiting_review";
    return summary;
  }

  const finalStatus: TerminalOptimizationStatus = settleOptimizationStatus({
    cancelled,
    infraFailed: infraFailure !== null,
    evaluatedCandidates: finalCounters.candidates.filter((entry) => entry.metrics !== null).length,
    acceptedCandidates: finalCounters.candidates.filter((entry) => entry.decisionKind === "ACCEPT").length,
    stoppedEarly: stopReason !== null && stopReason !== "max_iterations",
  });

  await settle(sessionId, {
    status: finalStatus,
    reason: infraFailure === null ? stopReason : "infrastructure_failure",
    note: infraFailure,
    summary,
  });

  summary.status = finalStatus;
  summary.stopReason = stopReason ?? (infraFailure === null ? null : "infrastructure_failure");
  return summary;
}

/** Finalizes a session: status, counters, recommendation and the report. */
async function settle(
  sessionId: string,
  input: {
    status: Extract<
      OptimizationStatus,
      "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELLED"
    >;
    reason: StopReason | null;
    note: string | null;
    summary: OptimizationRunSummary;
  },
): Promise<void> {
  const session = await optimizationRepository.findById(sessionId);
  if (session === null) {
    return;
  }
  const counters = await refreshCounters(sessionId);
  const findings = await optimizationRepository.listFindings(sessionId);
  const hypotheses = await optimizationRepository.listHypotheses(sessionId);
  const baselineMetrics = await optimizationRepository.loadBatchMetrics(session.sourceBatchId);
  const ranking = rankOptimizationCandidates({
    objective: session.objective,
    baseline: baselineMetrics,
    candidates: counters.candidates.map((entry) => ({
      id: entry.id,
      label: entry.label,
      status: entry.status,
      decisionKind: entry.decisionKind,
      metrics: entry.metrics,
    })),
  });
  const report = buildOptimizationReport({
    session,
    findings,
    hypotheses,
    candidates: counters.candidates,
    baselineMetrics,
    recommendation: {
      candidateId: ranking.leader?.candidateId ?? null,
      label: ranking.leader?.label ?? null,
      rationale:
        ranking.note === null
          ? (rankingsReasons(ranking, baselineMetrics, session) ?? [])
          : [ranking.note],
    },
  });

  await optimizationRepository.setBestCandidate(sessionId, ranking.leader?.candidateId ?? null);
  await optimizationRepository.setCounters(sessionId, {
    candidateCount: counters.candidatesCreated,
    runCount: counters.runCount,
    tokenUsage: counters.tokenUsage,
    estimatedCostUsd: counters.estimatedCostUsd,
    analyzerTokenUsage: counters.analyzerTokenUsage,
  });
  await optimizationRepository.saveReport(sessionId, report);
  await optimizationRepository.updateStatus(sessionId, {
    status: input.status,
    completedAt: new Date(),
    stopReason: input.reason,
  });
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "session.stopped",
    message:
      input.note ??
      `Stopped: ${input.reason ?? "completed"}. ${counters.candidatesCreated} candidate(s), ${counters.runCount} run(s).`,
    payload: {
      status: input.status,
      reason: input.reason,
      candidates: counters.candidatesCreated,
      runs: counters.runCount,
      tokens: counters.tokenUsage,
      estimatedCostUsd: counters.estimatedCostUsd,
    },
  });
  orchestratorLogger.info("optimization session settled", {
    sessionId,
    status: input.status,
    reason: input.reason,
    candidates: counters.candidatesCreated,
    runs: counters.runCount,
  });
}

/** Why the leader was chosen, stated in the objective's own terms. */
function rankingsReasons(
  ranking: ReturnType<typeof rankOptimizationCandidates>,
  baseline: BatchMetrics | null,
  session: OptimizationSessionRecord,
): string[] | null {
  const leader = ranking.leader;
  if (leader === null) {
    return null;
  }
  const reasons: string[] = [];
  const baselineValue = readBatchMetric(baseline, session.objective.primary.metric);
  reasons.push(
    `Best accepted candidate: ${leader.label} (primary metric ${session.objective.primary.metric}: ${baselineValue === null ? "n/a" : baselineValue} → ${leader.primary ?? "n/a"}).`,
  );
  const accepted = ranking.entries.filter((entry) => entry.eligible).length;
  reasons.push(`${accepted} candidate(s) satisfied every hard constraint.`);
  return reasons;
}
