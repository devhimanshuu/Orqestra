/**
 * Phase 4 verification — experiments: drafts, sealing, orchestration, metrics,
 * ranking, regressions, budgets, cancellation, selection, promotion, isolation.
 *
 * Scenario (mirrors the Phase 4 spec):
 *
 *   agent → harness B v1 (lean) + v2 (improved, unpublished) → harness C
 *   (minimal) → dataset v1 (3 cases) → two deterministic evaluators →
 *
 *   Experiment 1: baseline B v1 vs [B v2, C v1] with a pass-rate constraint
 *                 → improved candidate leads, is selected and promoted (B: v1→v2)
 *   Experiment 2: baseline B v2 vs [C v1] → every case regresses, the baseline
 *                 legitimately stays the leader
 *   Experiment 3: sealed (no dispatch) → pause → the orchestrator pass refuses
 *                 to claim it → resume → completes every execution exactly once;
 *                 a redelivered job runs nothing twice
 *   Experiment 4: a run budget of 2 → the experiment stops early as
 *                 PARTIALLY_COMPLETED instead of overrunning
 *   Experiment 5: sealed → cancelled → every unstarted case is recorded as
 *                 cancelled, and the claim is refused forever after
 *
 * Every step goes through the *production* service layer — exactly what the API
 * routes call — and executions run inline through the same orchestrator the queue
 * worker uses, so Redis is not required.
 *
 *   pnpm exec tsx scripts/verify-phase4.ts
 */

import { loadEnvFile } from "node:process";
import { getEnv, resetEnvCache } from "../src/config/env";
import type { AuthUser } from "../src/lib/auth/provider";
import { getPrisma } from "../src/lib/db/prisma";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import { publishHarnessVersion } from "../src/modules/harness/harness.service";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import { createDataset as createDatasetService } from "../src/modules/evaluation/dataset.service";
import { createEvaluator } from "../src/modules/evaluation/evaluator.service";
import { runExperimentJob } from "../src/modules/experiments/jobs/orchestrator";
import { createExperimentSchema } from "../src/modules/experiments/experiment.inputs";
import { isTerminalExperimentStatus } from "../src/modules/experiments/experiment.types";
import {
  ExperimentConflictError,
  ExperimentNotFoundError,
  ExperimentPromotionError,
  ExperimentValidationError,
} from "../src/modules/experiments/experiment.types";
import {
  cancelExperiment,
  compareExperiment,
  createExperiment,
  exportExperiment,
  getExperiment,
  getExperimentCandidates,
  getExperimentMetricsView,
  launchExperiment,
  listExperimentCases,
  listExperiments,
  pauseExperiment,
  planNewExperiment,
  planStoredExperiment,
  promoteCandidate,
  resumeExperiment,
  sealExperiment,
  selectCandidate,
  updateExperiment,
} from "../src/modules/experiments/experiment.service";

try {
  loadEnvFile();
} catch {
  // Env may come from the shell.
}

const MODEL = "mock:deterministic";
const AGENT_NAME = "Phase 4 Verification Agent";
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

/** Harness B v1 — lean: tool + planner, but no critic node type, so compliance fails. */
function leanDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "phase4-verification-lean",
    version: 1,
    name: "Phase 4 Verification — lean",
    description: "START → PLANNER → TOOL → ANSWER → END (no critic)",
    nodes: [
      node("start", "start", "Start"),
      node("planner", "planner", "Planner", {
        instructions: "Break the research task into verifiable steps.",
        maxSteps: 4,
      }),
      node("clock", "tool", "Clock", { toolId: "current_time" }),
      node("gate", "transform", "Compose answer", {
        expression: "{ summary: state.planStepCount }",
      }),
      node("end", "end", "End"),
    ],
    edges: [
      edge("e0", "start", "planner"),
      edge("e1", "planner", "clock"),
      edge("e2", "clock", "gate"),
      edge("e3", "gate", "end"),
    ],
    entryNode: "start",
    exitNodes: ["end"],
  } as HarnessDefinition;
}

/** Harness B v2 — the improved version: adds the critic, so compliance passes. */
function improvedDefinition(): HarnessDefinition {
  const definition = leanDefinition();
  return {
    ...definition,
    id: "phase4-verification-lean",
    version: 2,
    name: "Phase 4 Verification — lean + critic",
    description: "START → PLANNER → TOOL → CRITIC → ANSWER → END",
    nodes: [
      ...definition.nodes.slice(0, 3),
      node("critic", "critic", "Critic", {
        instructions: "Review the plan for coverage and evidence.",
        threshold: 0.7,
      }),
      ...definition.nodes.slice(3),
    ],
    edges: [
      edge("e0", "start", "planner"),
      edge("e1", "planner", "clock"),
      edge("e2", "clock", "critic"),
      edge("e3", "critic", "gate"),
      edge("e4", "gate", "end"),
    ],
  } as HarnessDefinition;
}

/** Harness C — the regressed control: START → END, so neither evaluator passes. */
function minimalDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "phase4-verification-minimal",
    version: 1,
    name: "Phase 4 Verification — minimal",
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
      slug: `phase4-verification-agent-${RUN_TAG}`,
      description: "Created by scripts/verify-phase4.ts",
      currentVersion: 1,
      versions: {
        create: {
          version: 1,
          purpose: "Verify the Phase 4 experiment engine end to end.",
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
    name: definition.name ?? slug,
    slug,
    description: definition.description ?? undefined,
    definition,
    contentHash: hashHarnessDefinition(definition),
    entryNode: definition.entryNode,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    status: "VALID",
    createdBy: user.id,
  });
  return {
    harnessId: created.harness.id,
    versionId: created.harnessVersion.id,
    version: created.harnessVersion.version,
  };
}

async function waitForExperiment(
  user: AuthUser,
  experimentId: string,
  timeoutMs = 240_000,
): Promise<string> {
  const startedAt = Date.now();
  let status = "QUEUED";
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await getExperiment(user, experimentId);
    status = detail.experiment.status;
    if (isTerminalExperimentStatus(detail.experiment.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return status;
}

async function main(): Promise<void> {
  process.stdout.write(`\nORQESTRA — Phase 4 verification (run tag ${RUN_TAG})\n\n`);

  process.env["RUN_EXECUTION_MODE"] = "inline";
  resetEnvCache();

  const user = await resolveDemoUser();
  const agent = await ensureAgent(user);
  process.stdout.write(`  agent:     ${agent.id} (project ${agent.projectId})\n`);

  // --- 1. harnesses: an unpublished v2 is what an experiment promotes to -----
  const lean = await ensureHarness(user, agent.id, leanDefinition(), `phase4-lean-${RUN_TAG}`);
  const minimal = await ensureHarness(user, agent.id, minimalDefinition(), `phase4-minimal-${RUN_TAG}`);

  const improvedDraft = await harnessRepository.findDraft(lean.harnessId);
  const published = await publishHarnessVersion(user, lean.harnessId, {
    definition: improvedDraft?.definition ?? improvedDefinition(),
    releaseNotes: `Add a critic before composing the answer (${RUN_TAG})`,
  });
  const harnessAfterPublish = await harnessRepository.findById(lean.harnessId);
  check(
    "publishing an improved version leaves currentVersion alone",
    published.created &&
      published.harnessVersion.version === lean.version + 1 &&
      harnessAfterPublish?.currentVersion === lean.version,
    `published v${published.harnessVersion.version}, harness still at v${harnessAfterPublish?.currentVersion ?? "n/a"} until promoted`,
  );
  const improvedVersionId = published.harnessVersion.id;
  const improvedContentHash = published.harnessVersion.contentHash;
  process.stdout.write(
    `  harness:   B v${lean.version} (${lean.versionId.slice(-6)}) → v${published.harnessVersion.version} (${improvedVersionId.slice(-6)}), C v${minimal.version} (${minimal.versionId.slice(-6)})\n\n`,
  );

  // --- 2. dataset and deterministic evaluators ------------------------------
  const { dataset } = await createDatasetService(user, {
    projectId: agent.projectId,
    name: `Phase 4 Verification Dataset ${RUN_TAG}`,
    description: "Created by scripts/verify-phase4.ts",
    cases: [
      { caseKey: "alpha", name: "Alpha", input: "Research the benefits of TypeScript.", tags: ["core"], expectedOutput: null },
      { caseKey: "beta", name: "Beta", input: "Research the risks of microservices.", tags: ["core"], expectedOutput: null },
      { caseKey: "gamma", name: "Gamma", input: "Summarise the CAP theorem.", tags: ["edge"], expectedOutput: null },
    ],
  });

  const toolUsage = await createEvaluator(user, {
    projectId: agent.projectId,
    name: `Tool usage ${RUN_TAG}`,
    kind: "tool_usage",
    config: { required: ["current_time"], minCalls: { current_time: 1 }, maxCalls: { current_time: 6 } },
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
  process.stdout.write(`  dataset:   ${dataset.id.slice(-6)} (3 cases), evaluators ${toolUsage.id.slice(-6)}, ${compliance.id.slice(-6)}\n\n`);

  const baseBody = {
    projectId: agent.projectId,
    agentId: agent.id,
    datasetId: dataset.id,
    evaluators: [{ evaluatorId: toolUsage.id }, { evaluatorId: compliance.id }],
    scoringPolicy: "REQUIRE_ALL" as const,
    passThreshold: 0.75,
  };

  // --- 3. pre-flight --------------------------------------------------------
  // Parsed exactly as the API route parses it, so the service receives the
  // same fully-defaulted body a real request would.
  const experiment1Body = createExperimentSchema.parse({
    ...baseBody,
    name: `Phase 4 Improvement ${RUN_TAG}`,
    description: "Does adding a critic before composing the answer improve correctness?",
    hypothesis: "A critic node raises the workflow-compliance score without extra tool calls.",
    baseline: { harnessVersionId: lean.versionId, label: "Baseline (lean v1)" },
    candidates: [
      { harnessVersionId: improvedVersionId, label: "Critic added", hypothesis: "Compliance passes with a critic" },
      { harnessVersionId: minimal.versionId, label: "Minimal", hypothesis: "Nothing should beat the full workflow" },
    ],
    objective: {
      primary: { metric: "evaluation_score" as const, direction: "maximize" as const },
      secondary: [{ metric: "pass_rate" as const, direction: "maximize" as const }],
      notes: "Correctness first; the pass-rate constraint is the guardrail.",
    },
    constraints: { minPassRate: 0.5, maxMedianLatencyMs: null },
    execution: {
      concurrency: 1,
      ordering: "interleaved" as const,
      replicates: 1,
      budget: { maxRuns: 50, maxTotalTokens: null, maxCostUsd: null },
    },
  });

  const plan1 = await planNewExperiment(user, experiment1Body);
  check(
    "pre-flight resolves every reference and validates the configuration",
    plan1.valid && plan1.issues.length === 0,
    plan1.valid ? `planned ${plan1.volume.plannedExecutions} execution(s)` : plan1.issues[0]?.message ?? "invalid",
  );
  check(
    "pre-flight states the execution volume, evaluators and pins",
    plan1.configuration.caseCount === 3 &&
      plan1.configuration.candidates.length === 2 &&
      plan1.configuration.evaluators.length === 2 &&
      plan1.configuration.baseline.harnessVersion === lean.version,
    `${plan1.volume.candidateCount} candidates × ${plan1.volume.caseCount} cases × ${plan1.volume.replicates} replicate(s)`,
  );
  check(
    "pre-flight describes the objective and constraints in words",
    plan1.lines.objective.length > 0 && plan1.lines.constraints.some((line) => line.includes("50%")),
    plan1.lines.constraints[0] ?? "no constraint described",
  );
  check(
    "cost estimates are labelled as estimates and may be unavailable",
    plan1.estimate.billedNote === "estimated" &&
      (plan1.estimate.estimatedCostUsd === null || plan1.estimate.basis.length > 0),
    plan1.estimate.estimatedCostUsd === null
      ? "no comparable measured history — stated, not blocked"
      : `~$${plan1.estimate.estimatedCostUsd.toFixed(4)} from ${plan1.estimate.measuredBatches} measured batch(es)`,
  );
  check(
    "pre-flight records what can and cannot be reproduced",
    plan1.reproducibilityNotes.length > 0,
    `${plan1.reproducibilityNotes.length} note(s)`,
  );

  // A configuration that cannot be run is refused before anything is written.
  let invalidRejected = false;
  try {
    await createExperiment(user, {
      ...experiment1Body,
      candidates: [],
    });
  } catch (error) {
    invalidRejected = error instanceof ExperimentValidationError || error instanceof Error;
    check(
      "an experiment with no candidates is refused",
      invalidRejected,
      error instanceof Error ? error.message.slice(0, 100) : String(error),
    );
  }
  if (!invalidRejected) {
    check("an experiment with no candidates is refused", false, "creation unexpectedly succeeded");
  }

  // --- 4. draft → sealed launch --------------------------------------------
  const experiment1 = await createExperiment(user, experiment1Body);
  check(
    "draft created with the resolved configuration and no execution",
    experiment1.status === "DRAFT" &&
      experiment1.caseCount === 3 &&
      experiment1.plannedRunCount === 9 &&
      experiment1.configSnapshot === null,
    `${experiment1.caseCount} cases, ${experiment1.plannedRunCount} planned executions, snapshot ${experiment1.configSnapshot === null ? "not written" : "written"}`,
  );

  const storedPlan = await planStoredExperiment(user, experiment1.id);
  check(
    "the stored draft re-resolves before launch",
    storedPlan.valid && storedPlan.configuration.caseCount === 3,
    `${storedPlan.checks.length} check(s)`,
  );

  const renamed = await updateExperiment(user, experiment1.id, { name: `Renamed ${RUN_TAG}` });
  check("a draft can still be edited", renamed.name === `Renamed ${RUN_TAG}`, renamed.name);

  const launched = await launchExperiment(user, experiment1.id, { confirm: true });
  const experiment1Record = launched.experiment;
  check(
    "launch seals the experiment and writes the immutable snapshot",
    experiment1Record.status === "QUEUED" &&
      experiment1Record.configSnapshot !== null &&
      experiment1Record.caseCount === 3 &&
      experiment1Record.plannedRunCount === 9,
    `status ${experiment1Record.status}, dispatch ${launched.dispatch.mode}`,
  );
  check(
    "the snapshot pins every harness version and the dataset version",
    experiment1Record.configSnapshot !== null &&
      experiment1Record.configSnapshot.candidates.length === 3 &&
      experiment1Record.configSnapshot.dataset.versionId === experiment1Record.datasetVersionId,
    experiment1Record.configSnapshot === null
      ? "no snapshot"
      : experiment1Record.configSnapshot.candidates.map((entry) => `${entry.label}@v${entry.harnessVersion}`).join(", "),
  );

  let relaunchRefused = false;
  try {
    await launchExperiment(user, experiment1.id, { confirm: true });
  } catch (error) {
    relaunchRefused = error instanceof ExperimentConflictError;
    check(
      "launching twice is refused",
      relaunchRefused,
      error instanceof Error ? error.message.slice(0, 100) : String(error),
    );
  }
  if (!relaunchRefused) {
    check("launching twice is refused", false, "the sealed experiment was launched again");
  }

  let editRefused = false;
  try {
    await updateExperiment(user, experiment1.id, { name: "Sneaky edit" });
  } catch (error) {
    editRefused = error instanceof ExperimentConflictError;
    check("editing a sealed experiment is refused", editRefused, "configuration is immutable after launch");
  }
  if (!editRefused) {
    check("editing a sealed experiment is refused", false, "the sealed configuration was edited");
  }

  // --- 5. execution ---------------------------------------------------------
  const experiment1Status = await waitForExperiment(user, experiment1.id);
  const detail1 = await getExperiment(user, experiment1.id);
  check(
    "the experiment runs through the runtime and settles",
    experiment1Status === "COMPLETED",
    `status ${experiment1Status}, progress ${detail1.progress.completed}/${detail1.progress.plannedExecutions}`,
  );
  check(
    "progress is derived from the persisted case rows",
    detail1.progress.pending === 0 && detail1.progress.running === 0 && detail1.progress.percent === 1,
    `${detail1.progress.completed} completed, ${detail1.progress.failed} failed, ${detail1.progress.percent * 100}% settled`,
  );
  check(
    "every candidate executed every case exactly once",
    detail1.candidates.length === 3 &&
      detail1.candidates.every((candidate) => candidate.progress.plannedExecutions === 3 && candidate.progress.completed === 3),
    detail1.candidates.map((candidate) => `${candidate.label}: ${candidate.progress.completed}/3`).join(", "),
  );

  const metrics1 = await getExperimentMetricsView(user, experiment1.id, { withAnalysis: true });
  const metricsOf = (label: string) => metrics1.metrics.find((entry) => entry.label === label);
  const improved = metricsOf("Critic added");
  const baseline = metricsOf("Baseline (lean v1)");
  const minimalMetrics = metricsOf("Minimal");
  // The mock model and both evaluators are deterministic, so the expectations
  // follow from their formulas: tool usage gives the baseline and the critic
  // 3/3 and the minimal harness 1/3; harness compliance counts met
  // requirements — 6/7 without the critic, 7/7 with it, 3/7 for start→end —
  // and REQUIRE_ALL averages the two (13/14, 1, 8/21). A value that drifts
  // from this means the aggregate stopped reflecting the executed cases.
  check(
    "metrics come from the actual executions, not from a hardcoded value",
    improved?.score.mean === 1 &&
      improved?.passRate === 1 &&
      baseline?.passRate === 1 &&
      minimalMetrics?.passRate === 0 &&
      Math.abs((baseline?.score.mean ?? Number.NaN) - 13 / 14) < 1e-4 &&
      Math.abs((minimalMetrics?.score.mean ?? Number.NaN) - 8 / 21) < 1e-4,
    `baseline ${baseline?.score.mean}/pass ${baseline?.passRate}, critic ${improved?.score.mean}/pass ${improved?.passRate}, minimal ${minimalMetrics?.score.mean}/pass ${minimalMetrics?.passRate}`,
  );
  check(
    "token usage and estimated cost are reported per candidate",
    improved !== undefined && improved.tokens.reported === 3 && improved.cost.billedNote === "estimated",
    `${improved?.tokens.total ?? 0} tokens across ${improved?.tokens.reported ?? 0} run(s), cost ${improved?.cost.costUsd ?? "unpriced"}`,
  );
  check(
    "execution observability is recorded per candidate (steps, tool calls, latency)",
    improved !== undefined && improved.toolInvocations > 0 && improved.latency.measured === 3,
    `${improved?.toolInvocations ?? 0} tool call(s), median latency ${improved?.latency.medianMs ?? "n/a"} ms`,
  );

  const cases1 = await listExperimentCases(user, experiment1.id, { status: undefined, limit: 50 });
  check(
    "per-case results are aligned by case key with the baseline beside each candidate",
    cases1.total === 3 &&
      cases1.cases.every((entry) => entry.baseline !== null && entry.candidates.length === 2),
    `${cases1.total} aligned case(s), ${cases1.cases[0]?.candidates.length ?? 0} candidate column(s)`,
  );
  check(
    "every case execution links back to a real run",
    cases1.cases.every((entry) => entry.baseline?.trials.every((trial) => trial.runId !== null) ?? false),
    `e.g. run #${cases1.cases[0]?.baseline?.trials[0]?.runId?.slice(-6) ?? "none"}`,
  );

  // An aggregate that cannot be recomputed from the rows it summarizes would
  // be a dashboard number, not a measurement — cross-check the two reads.
  const caseMeanOf = (label: string): number | null => {
    const values = cases1.cases
      .map((entry) =>
        label === "Baseline (lean v1)"
          ? entry.baseline?.meanScore
          : entry.candidates.find((side) => side.label === label)?.observation?.meanScore,
      )
      .filter((value): value is number => typeof value === "number");
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  check(
    "aggregate metrics agree with the per-case rows they summarize",
    ["Baseline (lean v1)", "Critic added", "Minimal"].every((label) => {
      const fromCases = caseMeanOf(label);
      const fromMetrics = metricsOf(label)?.score.mean ?? null;
      return fromCases !== null && fromMetrics !== null && Math.abs(fromCases - fromMetrics) < 1e-6;
    }),
    `baseline ${caseMeanOf("Baseline (lean v1)")}, critic ${caseMeanOf("Critic added")}, minimal ${caseMeanOf("Minimal")}`,
  );

  // --- 6. ranking, constraints and evidence --------------------------------
  const ranking1 = metrics1.ranking;
  check(
    "the ranking follows the configured objective",
    ranking1.leader?.label === "Critic added" && ranking1.leaderNote.includes("Mean evaluation score"),
    ranking1.leaderNote,
  );
  check(
    "a candidate that violates a constraint is never the winner",
    ranking1.candidates.find((entry) => entry.metrics.label === "Minimal")?.rank === null &&
      ranking1.candidates.find((entry) => entry.metrics.label === "Minimal")?.eligibleForWin === false,
    ranking1.candidates
      .find((entry) => entry.metrics.label === "Minimal")
      ?.winBlockers[0]?.slice(0, 90) ?? "no blockers reported",
  );
  const improvedRanking = metrics1.ranking.candidates.find(
    (entry) => entry.metrics.label === "Critic added",
  );
  check(
    "the improvement is reported without a statistical claim on a small sample",
    improvedRanking?.analysis?.evidence.verdict === "insufficient_sample" &&
      improvedRanking?.analysis?.primary.direction === "improved",
    improvedRanking?.analysis?.evidence.explanation.slice(0, 110) ?? "no evidence reported",
  );

  const comparison1 = await compareExperiment(user, experiment1.id, {
    candidateId: undefined,
    baselineCandidateId: undefined,
    includeCases: true,
    regressionsOnly: false,
  });
  const criticComparison = comparison1.candidates.find(
    (entry) => entry.metrics.label === "Critic added",
  );
  const criticPrimary = criticComparison?.primary ?? null;
  check(
    "the comparison reports absolute and percentage differences",
    criticPrimary !== null &&
      typeof criticPrimary.baseline === "number" &&
      typeof criticPrimary.candidate === "number" &&
      typeof criticPrimary.delta === "number" &&
      Math.abs(criticPrimary.baseline - (baseline?.score.mean ?? Number.NaN)) < 1e-6 &&
      Math.abs(criticPrimary.candidate - (improved?.score.mean ?? Number.NaN)) < 1e-6 &&
      criticPrimary.delta === Number((criticPrimary.candidate - criticPrimary.baseline).toFixed(6)) &&
      criticPrimary.deltaPercent ===
        Number(
          (
            (Number((criticPrimary.candidate - criticPrimary.baseline).toFixed(6)) /
              Math.abs(criticPrimary.baseline)) *
            100
          ).toFixed(2),
        ) &&
      criticPrimary.explanation.includes("%"),
    criticPrimary === null
      ? "no primary movement reported"
      : `${criticPrimary.baseline} → ${criticPrimary.candidate} (Δ ${criticPrimary.delta}, ${criticPrimary.deltaPercent}%)`,
  );
  const minimalSide = comparison1.candidates.find((entry) => entry.metrics.label === "Minimal");
  check(
    "path changes are reported as leads, not as verdicts",
    (minimalSide?.pathChanges.length ?? 0) > 0,
    `${minimalSide?.pathChanges.length ?? 0} case(s) ran a different execution path`,
  );

  // --- 7. selection and promotion ------------------------------------------
  const criticCandidate = detail1.candidates.find((candidate) => candidate.label === "Critic added");
  check(
    "the improved candidate pins the newer immutable version",
    criticCandidate?.harnessVersionId === improvedVersionId && criticCandidate?.harnessVersion === published.harnessVersion.version,
    `v${criticCandidate?.harnessVersion} (${criticCandidate?.harnessVersionId.slice(-6)})`,
  );

  const selected = await selectCandidate(user, experiment1.id, {
    candidateId: criticCandidate?.id ?? "",
    kind: "SELECTED",
    notes: "Correctness improved on every case with the critic node.",
  });
  check(
    "selection records who decided, when and on what evidence",
    selected.experiment.selectedCandidateId === criticCandidate?.id &&
      selected.experiment.selectedBy === user.id &&
      selected.experiment.selectedAt !== null,
    `${selected.warnings.length} warning(s) surfaced with the decision`,
  );

  const promoted = await promoteCandidate(user, experiment1.id, {
    candidateId: criticCandidate?.id,
    passRateThreshold: 0.75,
    notes: "Critic node improves compliance on every verified case.",
  });
  const harnessAfterPromotion = await harnessRepository.findById(lean.harnessId);
  const versionAfterPromotion = await harnessRepository.findVersionById(improvedVersionId);
  check(
    "promotion advances the harness to the candidate's immutable version",
    promoted.harnessVersion.version === published.harnessVersion.version &&
      promoted.promotedFrom === lean.version,
    `harness advanced v${promoted.promotedFrom} → v${promoted.harnessVersion.version}`,
  );
  check(
    "promotion never mutates a published version or the baseline",
    versionAfterPromotion?.contentHash === improvedContentHash &&
      (await harnessRepository.findVersionById(lean.versionId))?.contentHash === hashHarnessDefinition(leanDefinition()) &&
      harnessAfterPromotion?.currentVersion === published.harnessVersion.version,
    `v${published.harnessVersion.version} hash ${versionAfterPromotion?.contentHash.slice(0, 12)}… unchanged`,
  );
  check(
    "the experiment records the promotion decision",
    experiment1Record.promotedCandidateId === null &&
      (await getExperiment(user, experiment1.id)).experiment.promotedCandidateId === criticCandidate?.id,
    "promoted candidate, notes and timestamp recorded",
  );

  // --- 8. a second experiment: regressions against a passing baseline -------
  const experiment2 = await createExperiment(
    user,
    createExperimentSchema.parse({
      ...baseBody,
      name: `Phase 4 Regression ${RUN_TAG}`,
      hypothesis: "Nothing should beat the critic workflow.",
      baseline: { harnessVersionId: improvedVersionId, label: "Baseline (critic)" },
      candidates: [{ harnessVersionId: minimal.versionId, label: "Minimal" }],
      objective: { primary: { metric: "evaluation_score" as const, direction: "maximize" as const }, secondary: [] },
      constraints: { minPassRate: 0.9 },
      execution: { concurrency: 2, ordering: "interleaved" as const, replicates: 1 },
    }),
  );
  await launchExperiment(user, experiment2.id, { confirm: true });
  const experiment2Status = await waitForExperiment(user, experiment2.id);
  const comparison2 = await compareExperiment(user, experiment2.id, {
    candidateId: undefined,
    baselineCandidateId: undefined,
    includeCases: true,
    regressionsOnly: false,
  });
  const regressionSide = comparison2.candidates.find((entry) => entry.metrics.label === "Minimal");
  check(
    "a candidate that fails where the baseline passes is listed as a regression",
    experiment2Status === "COMPLETED" && (regressionSide?.regressions.length ?? 0) === 3,
    `${regressionSide?.regressions.length ?? 0} regression(s) on ${comparison2.cases.length} aligned case(s)`,
  );
  check(
    "the baseline legitimately stays the leader when nothing beats it",
    comparison2.ranking.leader?.candidateId === comparison2.baselineCandidateId &&
      comparison2.ranking.leaderNote.includes("no candidate improved"),
    comparison2.ranking.leaderNote,
  );
  const regressionTraces = comparison2.cases[0]?.candidates[0]?.observation?.trials ?? [];
  check(
    "every regression links back to the runs that produced it",
    regressionTraces.length > 0 && regressionTraces.every((trial) => trial.runId !== null),
    `${regressionTraces.length} trace(s) for the first aligned case`,
  );

  // --- 9. lifecycle: seal, pause, resume, cancel, no duplicate work ---------
  //
  // Sealing is deliberately split from dispatch, so the lifecycle can be verified
  // without Redis: the experiment is sealed exactly as a launch seals it, and
  // nothing executes until an orchestrator pass claims it.
  const experiment3 = await createExperiment(
    user,
    createExperimentSchema.parse({
      ...baseBody,
      name: `Phase 4 Lifecycle ${RUN_TAG}`,
      baseline: { harnessVersionId: improvedVersionId, label: "Baseline (critic)" },
      candidates: [{ harnessVersionId: minimal.versionId, label: "Minimal" }],
      execution: { concurrency: 1, ordering: "interleaved" as const, replicates: 1 },
    }),
  );
  const sealed3 = await sealExperiment(user, experiment3.id);
  check(
    "sealing writes the immutable snapshot and schedules nothing",
    sealed3.experiment.status === "QUEUED" && sealed3.experiment.configSnapshot !== null,
    `status ${sealed3.experiment.status}, ${sealed3.experiment.plannedRunCount} execution(s) planned`,
  );

  const prisma = getPrisma();
  /**
   * Runs created for the given batches. Run has no batch column — provenance
   * lives in run metadata — so the count follows the JSON path the runtime
   * writes (see createPendingRun's provenance metadata).
   */
  const runsForBatches = async (batchIds: string[]): Promise<number> =>
    batchIds.length === 0
      ? 0
      : await prisma.run.count({
          where: {
            OR: batchIds.map((batchId) => ({ metadata: { path: ["evaluationBatchId"], equals: batchId } })),
          },
        });
  const batchIds3 = (
    await prisma.experimentCandidateReplicate.findMany({
      where: { candidate: { experimentId: experiment3.id } },
      select: { evaluationBatchId: true },
    })
  ).map((row) => row.evaluationBatchId);
  const runsSealed3 = await runsForBatches(batchIds3);
  check(
    "a sealed experiment has executed nothing yet",
    runsSealed3 === 0 && batchIds3.length === 2,
    `${batchIds3.length} sealed batch(es), ${runsSealed3} run(s)`,
  );

  // A second experiment for the same agent and dataset version is refused while
  // one is still in flight — two experiments over one dataset must not race.
  let clashRefused = false;
  try {
    const clashing = await createExperiment(user, {
      ...baseBody,
      name: `Phase 4 Clash ${RUN_TAG}`,
      baseline: { harnessVersionId: improvedVersionId, label: "Baseline" },
      candidates: [{ harnessVersionId: minimal.versionId, label: "Minimal" }],
    });
    await sealExperiment(user, clashing.id);
  } catch (error) {
    clashRefused = error instanceof ExperimentConflictError;
    check(
      "a second experiment over the same agent and dataset version is refused while one is in flight",
      clashRefused,
      error instanceof Error ? error.message.slice(0, 110) : String(error),
    );
  }
  if (!clashRefused) {
    check(
      "a second experiment over the same agent and dataset version is refused while one is in flight",
      false,
      "two in-flight experiments were allowed",
    );
  }

  const paused3 = await pauseExperiment(user, experiment3.id);
  check(
    "pausing records the intent durably",
    paused3.status === "PAUSED" && paused3.pausedAt !== null,
    `status ${paused3.status}`,
  );

  const passWhilePaused = await runExperimentJob(experiment3.id, { transport: "inline" });
  const runsWhilePaused = await runsForBatches(batchIds3);
  check(
    "a paused experiment cannot be claimed, so nothing runs behind the author's back",
    passWhilePaused.claimed === false && runsWhilePaused === 0,
    `claim ${passWhilePaused.claimed}, ${runsWhilePaused} run(s)`,
  );

  const resumed3 = await resumeExperiment(user, experiment3.id);
  check(
    "resuming clears the pause and re-arms the experiment",
    resumed3.experiment.status === "QUEUED" && resumed3.experiment.pausedAt === null,
    `dispatch ${resumed3.dispatch.mode}, nonce ${resumed3.dispatch.nonce}`,
  );
  const experiment3Status = await waitForExperiment(user, experiment3.id);
  const detail3 = await getExperiment(user, experiment3.id);
  check(
    "a resumed experiment finishes every planned execution exactly once",
    experiment3Status === "COMPLETED" &&
      detail3.progress.completed === 6 &&
      detail3.progress.pending === 0 &&
      detail3.progress.failed === 0,
    `status ${experiment3Status}, ${detail3.progress.completed}/${detail3.progress.plannedExecutions} completed`,
  );

  const redelivered3 = await runExperimentJob(experiment3.id, {
    transport: "inline",
    nonce: "redelivery",
  });
  const runsAfterRedelivery = await runsForBatches(batchIds3);
  check(
    "a redelivered job for a settled experiment runs no case twice",
    redelivered3.claimed === false && redelivered3.completed === 0 && runsAfterRedelivery === 6,
    `claim ${redelivered3.claimed}, ${runsAfterRedelivery} run(s)`,
  );

  // --- 9b. cancellation of a sealed, unstarted experiment -------------------
  const experiment5 = await createExperiment(user, {
    ...baseBody,
    name: `Phase 4 Cancellation ${RUN_TAG}`,
    baseline: { harnessVersionId: improvedVersionId, label: "Baseline (critic)" },
    candidates: [{ harnessVersionId: minimal.versionId, label: "Minimal" }],
  });
  await sealExperiment(user, experiment5.id);
  const batchIds5 = (
    await prisma.experimentCandidateReplicate.findMany({
      where: { candidate: { experimentId: experiment5.id } },
      select: { evaluationBatchId: true },
    })
  ).map((row) => row.evaluationBatchId);

  const cancelled5 = await cancelExperiment(user, experiment5.id);
  check(
    "cancellation records the intent and settles the experiment",
    cancelled5.experiment.status === "CANCELLED" && cancelled5.experiment.cancelRequestedAt !== null,
    `${cancelled5.runningExecutions} execution(s) were in flight`,
  );

  const cancelledCases5 = await prisma.evaluationCaseResult.count({
    where: { batchId: { in: batchIds5 }, status: "CANCELLED" },
  });
  const pendingCases5 = await prisma.evaluationCaseResult.count({
    where: { batchId: { in: batchIds5 }, status: "PENDING" },
  });
  check(
    "cases that never started are recorded as cancelled, never as failed",
    cancelledCases5 === 6 && pendingCases5 === 0,
    `${cancelledCases5} cancelled, ${pendingCases5} still pending`,
  );

  const passAfterCancel = await runExperimentJob(experiment5.id, { transport: "inline" });
  const runsAfterCancel = await runsForBatches(batchIds5);
  check(
    "a cancelled experiment never executes again (idempotent, claim refused)",
    passAfterCancel.claimed === false && runsAfterCancel === 0,
    `claim ${passAfterCancel.claimed}, ${runsAfterCancel} run(s)`,
  );

  let cancelAgainRefused = false;
  try {
    await cancelExperiment(user, experiment5.id);
  } catch (error) {
    cancelAgainRefused = error instanceof ExperimentConflictError;
  }
  check(
    "cancelling twice is refused rather than silently repeated",
    cancelAgainRefused,
    "a settled experiment cannot be cancelled again",
  );

  // --- 10. budgets and redelivery ------------------------------------------
  const experiment4 = await createExperiment(
    user,
    createExperimentSchema.parse({
      ...baseBody,
      name: `Phase 4 Budget ${RUN_TAG}`,
      baseline: { harnessVersionId: improvedVersionId, label: "Baseline (critic)" },
      candidates: [{ harnessVersionId: minimal.versionId, label: "Minimal" }],
      execution: {
        concurrency: 1,
        ordering: "interleaved" as const,
        replicates: 1,
        // 3 cases × 2 candidates = 9 planned executions, budgeted to 2.
        budget: { maxRuns: 2, maxTotalTokens: null, maxCostUsd: null },
      },
    }),
  );
  await launchExperiment(user, experiment4.id, { confirm: true });
  const experiment4Status = await waitForExperiment(user, experiment4.id);
  const detail4 = await getExperiment(user, experiment4.id);
  check(
    "a run budget stops the experiment early instead of overrunning it",
    experiment4Status === "PARTIALLY_COMPLETED" && detail4.progress.completed === 2,
    `status ${experiment4Status}, ${detail4.progress.completed} of ${detail4.progress.plannedExecutions} executions completed`,
  );
  check(
    "a budget stop is reported as partially completed, never as a success",
    detail4.progress.failed === 0 && detail4.progress.pending > 0,
    `${detail4.progress.pending} execution(s) never started because of the budget`,
  );

  const redelivered = await runExperimentJob(experiment4.id, {
    transport: "inline",
    nonce: "redelivery",
  });
  check(
    "a redelivered job for a settled experiment does nothing",
    redelivered.claimed === false && redelivered.completed === 0,
    `claim ${redelivered.claimed}, ${redelivered.completed} case(s) executed`,
  );

  // --- 11. list, export and reproducibility --------------------------------
  const listed = await listExperiments(user, {
    status: undefined,
    q: RUN_TAG,
    sort: "createdAt",
    order: "desc",
    limit: 20,
  });
  check(
    "the experiments list reports a leader only when the evidence names one",
    listed.items.length >= 4 &&
      listed.items.some((item) => item.name.includes("Renamed") && item.leadingCandidateLabel === "Critic added") &&
      listed.items.some((item) => item.name.includes("Budget") && item.leadingCandidateLabel === null),
    listed.items.map((item) => `${item.name.slice(0, 22)} → ${item.leadingCandidateLabel ?? "no leader"}`).join(" | "),
  );

  const jsonExport = await exportExperiment(user, experiment1.id, { format: "json" });
  const report = JSON.parse(jsonExport.body) as Record<string, unknown>;
  check(
    "the JSON export carries the sealed configuration, metrics and ranking",
    jsonExport.contentType.includes("application/json") &&
      (report["configurationSnapshot"] !== undefined) &&
      Array.isArray(report["candidates"]) &&
      (report["cases"] as unknown[]).length === 9,
    `${(report["cases"] as unknown[]).length} case rows, ${(report["candidates"] as unknown[]).length} candidates`,
  );
  check(
    "the export is sanitized and never contains a credential",
    jsonExport.body.toUpperCase().includes("SANITIZED") &&
      !/API[_-]?KEY|SECRET|PASSWORD|TOKEN"/i.test(JSON.stringify(report["configurationSnapshot"])),
    "configuration snapshot carries no credential-shaped field",
  );

  const csvExport = await exportExperiment(user, experiment1.id, { format: "csv" });
  const csvLines = csvExport.body.trim().split("\n");
  check(
    "the CSV export is one row per execution with the evaluator verdicts flattened",
    csvExport.contentType.includes("text/csv") && csvLines.length === 10 && csvLines[0]?.includes("eval:") === true,
    `${csvLines.length - 1} row(s)`,
  );

  // --- 12. workspace isolation ---------------------------------------------
  const outsider = await ensureOutsider();
  let isolatedExperiment = false;
  try {
    await getExperiment(outsider, experiment1.id);
  } catch (error) {
    isolatedExperiment = error instanceof ExperimentNotFoundError;
  }
  let isolatedDataset = false;
  try {
    await getExperimentCandidates(outsider, experiment1.id);
  } catch (error) {
    isolatedDataset = error instanceof ExperimentNotFoundError;
  }
  check(
    "another workspace cannot read an experiment or its candidates",
    isolatedExperiment && isolatedDataset,
    "both reads answered with not-found (existence is never disclosed)",
  );

  let promotionBlocked = false;
  try {
    await promoteCandidate(outsider, experiment1.id, { candidateId: criticCandidate?.id });
  } catch (error) {
    promotionBlocked = error instanceof ExperimentNotFoundError || error instanceof ExperimentPromotionError;
  }
  check(
    "an outsider cannot promote a candidate from someone else's experiment",
    promotionBlocked,
    "promotion refused for a non-member",
  );

  await removeOutsider(outsider);

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

/** A user in their own workspace, used to prove isolation is enforced. */
async function ensureOutsider(): Promise<AuthUser> {
  const prisma = getPrisma();
  const email = `phase4-outsider-${RUN_TAG}@example.com`;
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing !== null) {
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      emailVerified: existing.emailVerified,
      createdAt: existing.createdAt,
    };
  }

  const workspace = await prisma.workspace.create({
    data: { name: `Phase 4 Outsider Workspace ${RUN_TAG}`, slug: `phase4-outsider-${RUN_TAG}` },
  });
  const user = await prisma.user.create({
    data: { id: `phase4-outsider-${RUN_TAG}`, email, name: `Phase 4 Outsider ${RUN_TAG}`, emailVerified: true },
  });
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

/** Removes the outsider and their empty workspace. */
async function removeOutsider(user: AuthUser): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.deleteMany({
    where: { members: { some: { userId: user.id } }, projects: { none: {} } },
  });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
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
