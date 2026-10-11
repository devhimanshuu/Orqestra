/**
 * Phase 3 verification — datasets, evaluators, batches, comparison, export.
 *
 * Scenario (mirrors the Phase 3 spec):
 *
 *   dataset (3 cases) → publish v2 → evaluators (pinned revisions) →
 *   baseline batch (harness v1) → candidate batch (regressed harness v2) →
 *   comparison reports regressions → run-level evaluation → export.
 *
 * Every step goes through the *production* service layer, so this exercises
 * exactly what the API routes call. Batches execute inline
 * (`RUN_EXECUTION_MODE=inline`) through the same orchestrator the queue worker
 * uses — Redis is not required.
 *
 *   pnpm exec tsx scripts/verify-phase3.ts
 */

import { loadEnvFile } from "node:process";
import { getEnv } from "../src/config/env";
import type { AuthUser } from "../src/lib/auth/provider";
import { getPrisma } from "../src/lib/db/prisma";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import { isTerminalBatchStatus } from "../src/modules/evaluation/batch.types";
import {
  addDatasetCase,
  deleteDataset,
  exportDataset,
  createDataset as createDatasetService,
  getDatasetDetail,
  importDataset,
  listDatasets,
  publishDatasetVersion,
} from "../src/modules/evaluation/dataset.service";
import {
  createEvaluator,
  deleteEvaluator,
  listEvaluators,
  updateEvaluator,
  validateConfig,
} from "../src/modules/evaluation/evaluator.service";
import {
  compareEvaluationBatches,
  evaluateRun,
  exportEvaluationReport,
  getEvaluationBatch,
  getEvaluationMetrics,
  listEvaluationCases,
  listRunEvaluations,
  startEvaluationBatch,
} from "../src/modules/evaluation/evaluation.service";

try {
  loadEnvFile();
} catch {
  // Env may come from the shell.
}

process.env["RUN_EXECUTION_MODE"] = "inline";

const MODEL = "mock:deterministic";
const AGENT_NAME = "Phase 3 Verification Agent";
const RUN_TAG = Date.now().toString(36).slice(-5);

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}\n`);
}

function node(
  id: string,
  type: string,
  label: string,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, type, label, config, position: { x: 0, y: 0 } };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string,
): Record<string, unknown> {
  return { id, source, target, ...(sourceHandle !== undefined ? { sourceHandle } : {}) };
}

/**
 * The baseline harness: START → LOOP → PLANNER → TOOL(current_time) → CRITIC →
 * CONDITION → END, i.e. a run with a tool invocation, several node types and a
 * deterministic path. Both deterministic evaluators can score it fully.
 */
function baselineDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "phase3-verification-baseline",
    version: 1,
    name: "Phase 3 Verification — baseline",
    description: "START → LOOP → PLANNER → TOOL → CRITIC → CONDITION → END",
    nodes: [
      node("start", "start", "Start"),
      node("loop", "loop", "Refine loop", { maxIterations: 3 }),
      node("planner", "planner", "Planner", {
        instructions: "Break the research task into verifiable steps.",
        maxSteps: 4,
      }),
      node("clock", "tool", "Clock", { toolId: "current_time" }),
      node("critic", "critic", "Critic", {
        instructions: "Review the plan for coverage and evidence.",
        threshold: 0.7,
      }),
      node("gate", "condition", "Score gate", { expression: "state.score >= 0.7" }),
      node("answer", "transform", "Compose answer", {
        expression: "{ summary: state.critique, steps: state.planStepCount }",
      }),
      node("end", "end", "End"),
    ],
    edges: [
      edge("e0", "start", "loop"),
      edge("e1", "loop", "planner", "body"),
      edge("e2", "planner", "clock"),
      edge("e3", "clock", "critic"),
      edge("e4", "critic", "gate"),
      edge("e5", "gate", "answer", "true"),
      edge("e6", "gate", "loop", "false"),
      edge("e7", "loop", "end", "exit"),
      edge("e8", "answer", "end"),
    ],
    entryNode: "start",
    exitNodes: ["end"],
  } as HarnessDefinition;
}

/** The candidate harness: START → END. It skips the workflow the evaluators check. */
function minimalDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "phase3-verification-minimal",
    version: 1,
    name: "Phase 3 Verification — minimal (regressed)",
    description: "START → END",
    nodes: [node("start", "start", "Start"), node("end", "end", "End")],
    edges: [edge("e0", "start", "end")],
    entryNode: "start",
    exitNodes: ["end"],
  } as HarnessDefinition;
}

async function resolveDemoUser(): Promise<AuthUser> {
  const env = getEnv();
  const row = await getPrisma().user.findFirst({ where: { email: env.SEED_USER_EMAIL } });
  if (row === null) {
    throw new Error(
      `No local user for ${env.SEED_USER_EMAIL}. Run \`pnpm db:seed\` first (it provisions the demo account).`,
    );
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? "Demo User",
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
  };
}

async function ensureAgent(user: AuthUser): Promise<{ id: string; projectId: string }> {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirst({
    where: { members: { some: { userId: user.id } } },
    orderBy: { createdAt: "asc" },
    include: { projects: { orderBy: { createdAt: "asc" } } },
  });
  if (workspace === null || workspace.projects[0] === undefined) {
    throw new Error("No project found for the demo user — run `pnpm db:seed` first.");
  }
  const projectId = workspace.projects[0].id;

  const existing = await prisma.agent.findFirst({ where: { projectId, name: AGENT_NAME } });
  if (existing !== null) {
    return { id: existing.id, projectId };
  }

  const created = await prisma.agent.create({
    data: {
      projectId,
      name: AGENT_NAME,
      slug: `phase3-verification-agent-${RUN_TAG}`,
      description: "Created by scripts/verify-phase3.ts",
      currentVersion: 1,
      versions: {
        create: {
          version: 1,
          purpose: "Verify the Phase 3 evaluation engine end to end.",
          instructions:
            "You are a rigorous research agent. Plan, gather evidence, critique your own work, then answer.",
          modelConfig: { model: MODEL, temperature: 0.2 },
          capabilities: ["current_time", "calculator"],
          createdBy: user.id,
        },
      },
    },
  });
  return { id: created.id, projectId };
}

async function ensureHarness(
  user: AuthUser,
  agentId: string,
  definition: HarnessDefinition,
  slug: string,
): Promise<{ harnessId: string; versionId: string; version: number }> {
  const prisma = getPrisma();
  const projectId = (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).projectId;

  const existing = await harnessRepository.findBySlug(projectId, slug);
  if (existing !== null) {
    const latest = await harnessRepository.findLatestVersion(existing.id);
    if (latest !== null) {
      return { harnessId: existing.id, versionId: latest.id, version: latest.version };
    }
  }

  const created = await harnessRepository.createWithVersion({
    projectId,
    agentId,
    name: definition.name,
    slug,
    description: definition.description,
    definition,
    contentHash: hashHarnessDefinition(definition),
    entryNode: definition.entryNode,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    status: "VALID",
    createdBy: user.id,
  });
  await harnessRepository.upsertDraft({
    harnessId: created.harness.id,
    definition,
    status: "VALID",
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    updatedBy: user.id,
  });
  return {
    harnessId: created.harness.id,
    versionId: created.harnessVersion.id,
    version: created.harnessVersion.version,
  };
}

async function waitForBatch(user: AuthUser, batchId: string, timeoutMs = 180_000): Promise<string> {
  const startedAt = Date.now();
  let status = "PENDING";
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await getEvaluationBatch(user, batchId);
    status = detail.batch.status;
    if (isTerminalBatchStatus(detail.batch.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return status;
}

async function main(): Promise<void> {
  process.stdout.write(`\nORQESTRA — Phase 3 verification (run tag ${RUN_TAG})\n\n`);

  const user = await resolveDemoUser();
  const agent = await ensureAgent(user);
  process.stdout.write(`  agent:     ${agent.id} (project ${agent.projectId})\n`);

  // --- 1. datasets: working set, immutable versions, idempotent publish -----
  const datasetName = `Phase 3 Verification Dataset ${RUN_TAG}`;
  const canonicalCases = [
    { caseKey: "alpha", name: "Alpha", input: "Research the benefits of TypeScript.", tags: ["core"] },
    { caseKey: "beta", name: "Beta", input: "Research the risks of microservices.", tags: ["core"] },
    { caseKey: "gamma", name: "Gamma", input: "Summarise the CAP theorem.", tags: ["edge"] },
  ];
  const { dataset, version: initialVersion } = await createDatasetService(user, {
    projectId: agent.projectId,
    name: datasetName,
    description: "Created by scripts/verify-phase3.ts",
    cases: canonicalCases.map((entry) => ({ ...entry, expectedOutput: null })),
  });
  check(
    "dataset created with an initial version",
    dataset.caseCount === 3 && initialVersion.version === 1 && initialVersion.caseCount === 3,
    `${dataset.id.slice(-6)} v${initialVersion.version} with ${initialVersion.caseCount} case(s)`,
  );

  const existing = await listDatasets(user, { projectId: agent.projectId, q: RUN_TAG });
  check(
    "dataset listed with version/batch counts",
    existing.datasets.some((row) => row.id === dataset.id && row.versionCount >= 1),
    `${existing.total} dataset(s) match the run tag`,
  );

  await addDatasetCase(user, dataset.id, {
    caseKey: "delta",
    name: "Delta",
    input: "Explain eventual consistency.",
    tags: ["core"],
  });
  const publishedV2 = await publishDatasetVersion(user, dataset.id, {});
  const republished = await publishDatasetVersion(user, dataset.id, {});
  check(
    "working-set edit publishes a new immutable version",
    publishedV2.created && publishedV2.version.version === 2 && publishedV2.version.caseCount === 4,
    `v${publishedV2.version.version} with ${publishedV2.version.caseCount} cases`,
  );
  check(
    "publishing an unchanged corpus is a no-op version",
    !republished.created && republished.version.id === publishedV2.version.id,
    "same version returned, no duplicate",
  );

  const datasetDetail = await getDatasetDetail(user, dataset.id);
  check(
    "dataset detail carries the working set and versions",
    datasetDetail.cases.length === 4 && datasetDetail.versions.length === 2,
    `${datasetDetail.cases.length} cases, versions ${datasetDetail.versions.map((v) => v.version).join(", ")}`,
  );

  // --- 2. harnesses ---------------------------------------------------------
  const baseline = await ensureHarness(
    user,
    agent.id,
    baselineDefinition(),
    "verification-phase3-baseline",
  );
  const minimal = await ensureHarness(
    user,
    agent.id,
    minimalDefinition(),
    "verification-phase3-minimal",
  );
  process.stdout.write(
    `  harness:   baseline v${baseline.version} (${baseline.versionId.slice(-6)}), minimal v${minimal.version} (${minimal.versionId.slice(-6)})\n\n`,
  );

  // --- 3. evaluators: validation, immutable revisions -----------------------
  const invalid = validateConfig("tool_usage", { required: "current_time" });
  check(
    "invalid evaluator config is refused without saving",
    !invalid.ok && invalid.issues.length > 0,
    invalid.issues[0]?.message ?? "no issue reported",
  );

  const toolUsage = await createEvaluator(user, {
    projectId: agent.projectId,
    name: `Tool usage ${RUN_TAG}`,
    kind: "tool_usage",
    config: { required: ["current_time"], minCalls: { current_time: 1 }, maxCalls: { current_time: 5 } },
  });
  const compliance = await createEvaluator(user, {
    projectId: agent.projectId,
    name: `Workflow compliance ${RUN_TAG}`,
    kind: "harness_compliance",
    config: {
      requiredNodes: ["start", "planner", "gate", "end"],
      requiredNodeTypes: ["critic", "tool"],
      requireSucceededRun: true,
    },
  });
  check(
    "evaluators created with validated configuration",
    toolUsage.currentVersion === 1 && compliance.currentVersion === 1,
    `tool_usage v${toolUsage.currentVersion}, harness_compliance v${compliance.currentVersion}`,
  );

  const toolUsageV2 = await updateEvaluator(user, toolUsage.id, {
    config: {
      required: ["current_time"],
      minCalls: { current_time: 1 },
      maxCalls: { current_time: 4 },
    },
  });
  check(
    "changing configuration writes a new revision",
    toolUsageV2.current.version === 2,
    `v${toolUsageV2.current.version} (${toolUsageV2.versionCount} revisions)`,
  );

  const listedEvaluators = await listEvaluators(user, {
    projectId: agent.projectId,
    enabledOnly: false,
  });
  check(
    "evaluators listed with their current revision",
    listedEvaluators.some((row) => row.id === toolUsage.id && row.current.version === 2),
    `${listedEvaluators.length} evaluator(s)`,
  );

  // --- 4. baseline batch ----------------------------------------------------
  const started = await startEvaluationBatch(user, {
    agentId: agent.id,
    harnessVersionId: baseline.versionId,
    datasetId: dataset.id,
    datasetVersionId: publishedV2.version.id,
    label: `Baseline ${RUN_TAG}`,
    evaluators: [{ evaluatorId: toolUsage.id }, { evaluatorId: compliance.id }],
    scoringPolicy: "REQUIRE_ALL",
    passThreshold: 0.75,
    concurrency: 1,
  });
  check(
    "batch sealed and dispatched",
    started.batch.status === "PENDING" || started.batch.status === "RUNNING",
    `${started.batch.id.slice(-6)} with ${started.batch.caseCount} case(s), dispatch ${started.dispatch.mode}`,
  );
  check(
    "batch pins evaluator revisions and the harness snapshot",
    started.batch.evaluatorConfig.length === 2 &&
      started.batch.evaluatorConfig.some((entry) => entry.evaluatorVersion === 2) &&
      started.batch.harnessSnapshot.harnessVersionId === baseline.versionId,
    started.batch.evaluatorConfig.map((entry) => `${entry.kind}@v${entry.evaluatorVersion}`).join(", "),
  );

  const baselineStatus = await waitForBatch(user, started.batch.id);
  check("baseline batch settles", baselineStatus === "COMPLETED", `status ${baselineStatus}`);

  const baselineDetail = await getEvaluationBatch(user, started.batch.id);
  check(
    "batch progress derives from case rows",
    baselineDetail.progress.completedCount === 4 &&
      baselineDetail.progress.failedCount === 0 &&
      baselineDetail.progress.percent === 1,
    `${baselineDetail.progress.completedCount}/${baselineDetail.progress.caseCount} completed (${Math.round(baselineDetail.progress.percent * 100)}%)`,
  );

  const baselineCases = await listEvaluationCases(user, started.batch.id, { status: undefined });
  const allPass = baselineCases.cases.every(
    (entry) => entry.status === "COMPLETED" && entry.passed === true && entry.results.length === 2,
  );
  check(
    "every case scored and passed with both evaluators",
    allPass,
    baselineCases.cases
      .map((entry) => `${entry.caseKey}=${entry.aggregateScore ?? "n/a"}`)
      .join(", "),
  );
  const firstCaseRunId = baselineCases.cases.find((entry) => entry.runId !== null)?.runId ?? null;
  check(
    "cases created real runs through the run pipeline",
    firstCaseRunId !== null,
    `e.g. run #${firstCaseRunId?.slice(-6) ?? "none"}`,
  );

  const baselineMetrics = await getEvaluationMetrics(user, started.batch.id);
  check(
    "metrics computed from persisted rows",
    baselineMetrics.passRate === 1 &&
      baselineMetrics.score.mean === 1 &&
      baselineMetrics.perEvaluator.length === 2 &&
      baselineMetrics.perEvaluator.every((entry) => entry.meanScore === 1),
    `pass rate ${baselineMetrics.passRate}, mean ${baselineMetrics.score.mean}, ${baselineMetrics.perEvaluator.length} evaluator(s)`,
  );
  check(
    "token usage and estimated cost reported",
    baselineMetrics.tokens.reported === 4 && baselineMetrics.cost.billedNote === "estimated",
    `${baselineMetrics.tokens.total} tokens across ${baselineMetrics.tokens.reported} run(s), cost ${baselineMetrics.cost.costUsd}`,
  );
  check(
    "evaluator-side usage kept separate from agent usage",
    baselineMetrics.evaluatorUsage.calls === 0,
    "no judge calls, so evaluator usage is zero",
  );

  // The evaluator gets a new revision *after* the batch: the batch must keep
  // meaning exactly what it meant when it ran.
  await updateEvaluator(user, toolUsage.id, {
    config: {
      required: ["current_time"],
      minCalls: { current_time: 1 },
      maxCalls: { current_time: 3 },
    },
  });
  const pinnedAfterEdit = await getEvaluationBatch(user, started.batch.id);
  check(
    "editing an evaluator cannot rewrite a settled batch",
    pinnedAfterEdit.batch.evaluatorConfig.some(
      (entry) => entry.evaluatorId === toolUsage.id && entry.evaluatorVersion === 2,
    ),
    `batch still pins v2; the evaluator is now at v${(await listEvaluators(user, { projectId: agent.projectId, enabledOnly: false })).find((row) => row.id === toolUsage.id)?.current.version ?? "?"}`,
  );

  // --- 5. candidate batch + comparison -------------------------------------
  const candidate = await startEvaluationBatch(user, {
    agentId: agent.id,
    harnessVersionId: minimal.versionId,
    datasetId: dataset.id,
    datasetVersionId: publishedV2.version.id,
    label: `Candidate ${RUN_TAG}`,
    evaluators: [{ evaluatorId: toolUsage.id }, { evaluatorId: compliance.id }],
    scoringPolicy: "REQUIRE_ALL",
    passThreshold: 0.75,
    concurrency: 2,
  });
  const candidateStatus = await waitForBatch(user, candidate.batch.id);
  const candidateDetail = await getEvaluationBatch(user, candidate.batch.id);
  check(
    "candidate batch runs with different harness version",
    candidateStatus === "COMPLETED" &&
      candidateDetail.batch.harnessVersionId === minimal.versionId,
    `status ${candidateStatus}, harness v${candidateDetail.batch.harnessSnapshot.harnessVersion}`,
  );
  const candidateCases = await listEvaluationCases(user, candidate.batch.id, { status: undefined });
  check(
    "regressed harness fails the workflow evaluators",
    candidateCases.cases.every((entry) => entry.status === "COMPLETED" && entry.passed === false),
    candidateCases.cases.map((entry) => `${entry.caseKey}=${entry.aggregateScore ?? "n/a"}`).join(", "),
  );

  const comparison = await compareEvaluationBatches(user, {
    baseline: started.batch.id,
    candidate: candidate.batch.id,
    includeCases: true,
  });
  check(
    "comparison is compatible and aligns cases by key",
    comparison.compatible &&
      comparison.alignment.comparableCases === 4 &&
      comparison.alignment.onlyInBaseline.length === 0 &&
      comparison.alignment.onlyInCandidate.length === 0,
    `${comparison.alignment.comparableCases} comparable case(s)`,
  );
  check(
    "comparison reports regressions",
    comparison.regressions.length === 4 && comparison.summary.verdict === "regressed",
    `${comparison.regressions.length} regression(s) — ${comparison.summary.headline}`,
  );
  const passRateDelta = comparison.metrics.find((entry) => entry.key === "passRate");
  check(
    "metric deltas state direction and magnitude",
    passRateDelta?.direction === "regressed" && passRateDelta.delta === -1,
    `pass rate ${passRateDelta?.baseline} → ${passRateDelta?.candidate} (${passRateDelta?.deltaPercent ?? "n/a"}%)`,
  );

  let selfCompareRefused = false;
  try {
    await compareEvaluationBatches(user, {
      baseline: started.batch.id,
      candidate: started.batch.id,
      includeCases: false,
    });
  } catch {
    selfCompareRefused = true;
  }
  check(
    "comparing a batch with itself is refused",
    selfCompareRefused,
    "requires two different evaluations",
  );

  // --- 6. run-level evaluation (skip semantics) -----------------------------
  if (firstCaseRunId !== null) {
    const runEvaluation = await evaluateRun(user, firstCaseRunId, {
      evaluators: [{ evaluatorId: toolUsage.id }],
    });
    const skippedRunEvaluation = await evaluateRun(user, firstCaseRunId, {
      evaluators: [{ evaluatorId: (await ensureExactMatch(user, agent.projectId)).id }],
    });
    const runAggregate = runEvaluation.aggregate;
    const skippedAggregate = skippedRunEvaluation.aggregate;
    check(
      "run-level evaluation scores a finished run",
      runEvaluation.results.length === 1 && runAggregate?.status === "COMPLETE",
      `score ${runAggregate?.score ?? "n/a"}, status ${runAggregate?.status ?? "none"}`,
    );
    // A skipped evaluator must never be fabricated into a zero: the verdict is
    // SKIPPED and the aggregate carries no score at all (the engine records
    // FAILED — "no usable score", not "the agent failed").
    check(
      "an evaluator with nothing to score reports SKIPPED with no aggregate score",
      skippedRunEvaluation.results[0]?.status === "SKIPPED" &&
        skippedAggregate?.score === null &&
        skippedAggregate?.status !== "COMPLETE",
      `result ${skippedRunEvaluation.results[0]?.status}, aggregate ${skippedAggregate?.status ?? "none"} / score ${String(skippedAggregate?.score)}`,
    );
    const groups = await listRunEvaluations(user, firstCaseRunId);
    check(
      "run evaluations group batch and one-off verdicts separately",
      groups.length >= 2 &&
        groups.some((group) => group.batchId === started.batch.id) &&
        groups.some((group) => group.batchId === null),
      `${groups.length} group(s) on run #${firstCaseRunId.slice(-6)}`,
    );
  }

  // --- 7. export ------------------------------------------------------------
  const report = await exportEvaluationReport(user, started.batch.id);
  check(
    "evaluation report exports sanitized evidence",
    report.kind === "orqestra.evaluation-report" &&
      report.sanitized === true &&
      report.cases.length === 4 &&
      report.evaluators.length === 2,
    `${report.cases.length} case(s), ${report.evaluators.length} evaluator(s), truncated=${report.truncated}`,
  );

  // --- 8. dataset export/import and delete rules ----------------------------
  const datasetDocument = await exportDataset(user, dataset.id, { version: publishedV2.version.version });
  check(
    "dataset export is portable",
    datasetDocument.schemaVersion === 1 && datasetDocument.cases.length === 4,
    `${datasetDocument.cases.length} case(s), version ${datasetDocument.dataset.version}`,
  );

  const imported = await importDataset(user, {
    projectId: agent.projectId,
    document: {
      ...datasetDocument,
      dataset: { ...datasetDocument.dataset, name: `Imported ${RUN_TAG}` },
    },
    mode: "create",
  });
  check(
    "exported dataset imports into a new dataset",
    imported.importedCases === 4 && !imported.replaced,
    `${imported.dataset.id.slice(-6)} with ${imported.importedCases} case(s)`,
  );
  await deleteDataset(user, imported.dataset.id);

  let deleteRefused = false;
  try {
    await deleteDataset(user, dataset.id);
  } catch (error) {
    deleteRefused = true;
    check(
      "deleting a dataset pinned by batches is refused",
      error instanceof Error && error.message.includes("evaluation batch"),
      error instanceof Error ? error.message.slice(0, 110) : String(error),
    );
  }
  if (!deleteRefused) {
    check("deleting a dataset pinned by batches is refused", false, "delete unexpectedly succeeded");
  }

  // --- 9. evaluator deletion keeps stored results meaningful ----------------
  await deleteEvaluator(user, toolUsage.id);
  await deleteEvaluator(user, compliance.id);
  const afterEvaluatorDeletion = await getEvaluationBatch(user, started.batch.id);
  const metricsAfterDeletion = await getEvaluationMetrics(user, started.batch.id);
  check(
    "deleting an evaluator keeps the batch's snapshot and metrics",
    afterEvaluatorDeletion.batch.evaluatorConfig.length === 2 &&
      metricsAfterDeletion.score.mean === 1,
    "snapshot rows keep evaluator name/kind/version",
  );

  // --- summary --------------------------------------------------------------
  const passed = checks.filter((entry) => entry.ok).length;
  process.stdout.write(`\n  ${passed}/${checks.length} checks passed\n`);
  if (passed !== checks.length) {
    process.stdout.write("\n  FAILED CHECKS:\n");
    for (const entry of checks.filter((item) => !item.ok)) {
      process.stdout.write(`   - ${entry.name}: ${entry.detail}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

/** Lazily creates the exact-match evaluator used to prove SKIPPED semantics. */
async function ensureExactMatch(
  user: AuthUser,
  projectId: string,
): Promise<{ id: string }> {
  const existing = await listEvaluators(user, { projectId, enabledOnly: false });
  const found = existing.find((row) => row.kind === "exact_match" && row.name.includes(RUN_TAG));
  if (found !== undefined) {
    return { id: found.id };
  }
  const created = await createEvaluator(user, {
    projectId,
    name: `Exact match ${RUN_TAG}`,
    kind: "exact_match",
    config: {},
  });
  return { id: created.id };
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nverification crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  })
  .finally(() => {
    void import("../src/lib/redis/connection")
      .then(({ closeRedis }) => closeRedis())
      .catch(() => undefined);
  });
