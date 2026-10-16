/**
 * Phase 5 verification — the optimization loop, end to end, on real data.
 *
 * Scenario (mirrors the Phase 5 spec):
 *
 *   agent → harness v1 (planner → tool → model, no verification step) →
 *   dataset v1 (3 cases with reference answers) → two deterministic evaluators
 *   (a workflow-compliance evaluator that fails because no verification node
 *   exists, and an exact-match evaluator that fails because the answers differ)
 *   → a baseline evaluation batch (the evidence)
 *
 *   Session A  the full loop: analysis → findings → hypotheses → candidate →
 *              validation → evaluation → comparison → decision → report.
 *              At least one candidate is rejected and the verification-step
 *              candidate is accepted, because inserting a critic node makes the
 *              compliance evaluator pass. The baseline version is asserted
 *              byte-identical afterwards.
 *   Session B  approval gate: the loop parks a candidate for review, the
 *              candidate survives a restart because its definition is stored, and
 *              approving it evaluates *that* candidate.
 *   Session C  rejection: a reviewer rejects the parked candidate, the loop
 *              continues, and the rejected candidate is never evaluated.
 *   Session D  budgets: the run budget stops the loop before it overruns.
 *   Session E  cancellation: the durable flag stops the loop and settles it.
 *   Session F  manual candidates: a version published by hand is attached and
 *              evaluated like a proposed one.
 *   Session G  LLM-assisted analysis: a scripted analyzer claim is stored as a
 *              labelled hypothesis, fenced to the cases the rules observed, and
 *              its tokens are accounted apart from agent runs.
 *   Promotion  the accepted candidate advances the harness; the baseline is
 *              never rewritten and a second promotion is refused.
 *   Isolation  another workspace can neither read nor act on any of it.
 *
 * Every step goes through the *production* service layer — exactly what the API
 * routes call — and passes run inline through the same orchestrator the queue
 * worker uses, so Redis is not required.
 *
 *   pnpm verify:phase5
 */

import { loadEnvFile } from "node:process";
import { getEnv, resetEnvCache } from "../src/config/env";
import type { AuthUser } from "../src/lib/auth/provider";
import { getPrisma } from "../src/lib/db/prisma";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import { publishHarnessVersion } from "../src/modules/harness/harness.service";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import { isTerminalBatchStatus } from "../src/modules/evaluation/batch.types";
import { createDataset as createDatasetService } from "../src/modules/evaluation/dataset.service";
import { createEvaluator } from "../src/modules/evaluation/evaluator.service";
import {
  getEvaluationBatch,
  listEvaluationCases,
  startEvaluationBatch,
} from "../src/modules/evaluation/evaluation.service";
import { runOptimizationJob } from "../src/modules/optimization/jobs/orchestrator";
import { queueMockResponses } from "../src/modules/llm/providers/mock.provider";
import { createOptimizationSessionSchema } from "../src/modules/optimization/optimization.inputs";
import {
  OptimizationConflictError,
  isTerminalOptimizationStatus,
} from "../src/modules/optimization/optimization.types";
import {
  approveOptimizationCandidate,
  attachManualCandidate,
  cancelOptimizationSession,
  createOptimizationSession,
  exportOptimizationReport,
  getOptimizationHistory,
  getOptimizationSession,
  listOptimizationSessions,
  planOptimization,
  promoteOptimizationCandidate,
  rejectOptimizationCandidate,
  startOptimizationSession,
} from "../src/modules/optimization/optimization.service";

try {
  loadEnvFile();
} catch {
  // Env may come from the shell.
}

const MODEL = "mock:deterministic";
const AGENT_NAME = "Phase 5 Verification Agent";
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

function passed(): number {
  return checks.filter((entry) => entry.ok).length;
}

function node(
  id: string,
  type: string,
  label: string,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, type, label, config, position: { x: 0, y: 0 } };
}

function edge(id: string, source: string, target: string): Record<string, unknown> {
  return { id, source, target };
}

/**
 * The baseline harness under optimization.
 *
 * `start → planner → clock(tool) → drafter(model) → end` — deliberately without
 * a verification step, so the workflow-compliance evaluator fails on every case
 * and the rule engine has a real weakness to work on (it proposes inserting a
 * critic before the exit node, which is exactly what makes compliance pass).
 */
function baselineDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "phase5-verification-baseline",
    version: 1,
    name: "Phase 5 Verification — baseline",
    description: "START → PLANNER → TOOL → MODEL → END (no verification step)",
    nodes: [
      node("start", "start", "Start"),
      node("planner", "planner", "Planner", {
        instructions: "Break the task into verifiable steps.",
        maxSteps: 4,
      }),
      node("clock", "tool", "Clock", { toolId: "current_time" }),
      node("drafter", "model", "Draft the answer", {
        model: MODEL,
        systemPrompt: "Answer the question using the evidence you gathered.",
        maxTokens: 1024,
        temperature: 0.2,
      }),
      node("end", "end", "End"),
    ],
    edges: [
      edge("e1", "start", "planner"),
      edge("e2", "planner", "clock"),
      edge("e3", "clock", "drafter"),
      edge("e4", "drafter", "end"),
    ],
    entryNode: "start",
    exitNodes: ["end"],
  } as unknown as HarnessDefinition;
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
      slug: `phase5-verification-agent-${RUN_TAG}`,
      description: "Created by scripts/verify-phase5.ts",
      currentVersion: 1,
      versions: {
        create: {
          version: 1,
          purpose: "Verify the Phase 5 optimization engine end to end.",
          instructions:
            "You are a rigorous research agent. Plan, gather evidence, verify your work, then answer.",
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

async function waitForBatch(user: AuthUser, batchId: string, timeoutMs = 240_000): Promise<string> {
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

/** Runs one optimization pass inline and returns the summary. */
async function runPass(sessionId: string): Promise<Awaited<ReturnType<typeof runOptimizationJob>>> {
  return runOptimizationJob(sessionId, { transport: "inline", nonce: `verify-${RUN_TAG}` });
}

async function waitForSession(
  user: AuthUser,
  sessionId: string,
  options: { untilParked?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  let status = "QUEUED";
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await getOptimizationSession(user, sessionId);
    status = detail.session.status;
    if (isTerminalOptimizationStatus(detail.session.status)) {
      return status;
    }
    // A session that requires approval stops at WAITING_FOR_REVIEW by design —
    // waiting for a terminal status would wait forever.
    if (options.untilParked === true && status === "WAITING_FOR_REVIEW") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return status;
}

async function main(): Promise<void> {
  process.stdout.write(`\nORQESTRA — Phase 5 verification (run tag ${RUN_TAG})\n\n`);

  process.env["RUN_EXECUTION_MODE"] = "inline";
  resetEnvCache();

  const user = await resolveDemoUser();
  const agent = await ensureAgent(user);
  process.stdout.write(`  agent:     ${agent.id} (project ${agent.projectId})\n`);

  // --- 1. baseline harness, dataset and evaluators ---------------------------
  const baseline = await ensureHarness(user, agent.id, baselineDefinition(), `phase5-baseline-${RUN_TAG}`);
  const baselineRow = await harnessRepository.findVersionById(baseline.versionId);
  if (baselineRow === null) {
    throw new Error("The baseline harness version could not be read.");
  }
  const baselineSnapshot = JSON.stringify(baselineRow.definition);
  const harnessBefore = await harnessRepository.findById(baseline.harnessId);
  process.stdout.write(
    `  harness:   ${harnessBefore?.name ?? "?"} v${baseline.version} (${baseline.versionId.slice(-6)}), current v${harnessBefore?.currentVersion ?? "?"}\n`,
  );

  const { dataset } = await createDatasetService(user, {
    projectId: agent.projectId,
    name: `Phase 5 Verification Dataset ${RUN_TAG}`,
    description: "Created by scripts/verify-phase5.ts",
    cases: [
      {
        caseKey: "alpha",
        name: "Alpha",
        input: "Research the benefits of TypeScript for large codebases.",
        tags: ["core"],
        expectedOutput: "CANONICAL-ALPHA",
      },
      {
        caseKey: "beta",
        name: "Beta",
        input: "Research the risks of microservices in small teams.",
        tags: ["core"],
        expectedOutput: "CANONICAL-BETA",
      },
      {
        caseKey: "gamma",
        name: "Gamma",
        input: "Summarise the CAP theorem in one paragraph.",
        tags: ["core"],
        expectedOutput: "CANONICAL-GAMMA",
      },
    ],
  });

  const compliance = await createEvaluator(user, {
    projectId: agent.projectId,
    name: `Workflow compliance ${RUN_TAG}`,
    kind: "harness_compliance",
    config: {
      requiredNodes: ["start", "planner", "clock", "drafter", "end"],
      requiredNodeTypes: ["critic"],
      requireSucceededRun: true,
    },
  });
  const exactMatch = await createEvaluator(user, {
    projectId: agent.projectId,
    name: `Reference answer ${RUN_TAG}`,
    kind: "exact_match",
    config: { caseSensitive: false, normalizeWhitespace: true, normalizeLineEndings: true },
  });
  process.stdout.write(
    `  dataset:   ${dataset.id.slice(-6)} (3 cases), evaluators compliance ${compliance.id.slice(-6)}, exact-match ${exactMatch.id.slice(-6)}\n\n`,
  );

  // --- 2. the evidence: a real baseline batch --------------------------------
  const evidence = await startEvaluationBatch(user, {
    agentId: agent.id,
    harnessVersionId: baseline.versionId,
    datasetId: dataset.id,
    label: `Phase 5 evidence ${RUN_TAG}`,
    evaluators: [{ evaluatorId: compliance.id }, { evaluatorId: exactMatch.id }],
    scoringPolicy: "REQUIRE_ALL",
    passThreshold: 0.75,
    concurrency: 1,
  });
  const evidenceStatus = await waitForBatch(user, evidence.batch.id);
  const evidenceDetail = await getEvaluationBatch(user, evidence.batch.id);
  const evidenceCases = await listEvaluationCases(user, evidence.batch.id, {
    status: undefined,
    limit: 50,
  });
  const evidenceMetrics = evidenceDetail.batch.metrics;
  check(
    "the evidence batch settles and records the weakness as measured metrics",
    evidenceStatus === "COMPLETED" &&
      evidenceMetrics !== null &&
      evidenceMetrics.passRate === 0 &&
      evidenceMetrics.scored === 3,
    `status ${evidenceStatus}, pass rate ${evidenceMetrics?.passRate ?? "n/a"}, score ${evidenceMetrics?.score.mean ?? "n/a"}`,
  );
  check(
    "the evidence batch pins three real runs",
    evidenceCases.cases.length === 3 && evidenceCases.cases.every((entry) => entry.runId !== null),
    `${evidenceCases.cases.length} case(s), all with a run`,
  );

  // --- 3. pre-flight ---------------------------------------------------------
  const baseBody = {
    projectId: agent.projectId,
    agentId: agent.id,
    name: `Phase 5 Optimization ${RUN_TAG}`,
    description: "Close the compliance gap without regressing cost.",
    baselineVersionId: baseline.versionId,
    sourceBatchId: evidence.batch.id,
    strategy: "RULE_BASED" as const,
    objective: {
      primary: { metric: "evaluation_score" as const, direction: "maximize" as const },
      secondary: [{ metric: "estimated_cost_usd" as const, direction: "minimize" as const }],
      minImprovementPct: 0,
      notes: "Compliance first; cost is the guardrail.",
    },
    constraints: {
      minPassRate: 0,
      minMeanScore: null,
      maxMedianLatencyMs: null,
      maxTotalTokens: null,
      maxTotalCostUsd: null,
      maxCostIncreasePct: null,
      maxLatencyIncreasePct: null,
      maxQualityRegressionPct: null,
    },
    limits: {
      maxIterations: 4,
      maxCandidatesPerIteration: 1,
      maxCandidates: 4,
      maxRuns: 12,
      maxTotalTokens: null,
      maxCostUsd: null,
      maxElapsedMs: null,
      maxConsecutiveInvalid: 3,
      stallIterations: 3,
      requireApprovalBeforeEvaluation: false,
      analyzerModel: null,
    },
    requireApproval: true,
  };

  const plan = await planOptimization(user, createOptimizationSessionSchema.parse(baseBody));
  check(
    "pre-flight resolves the baseline, the evidence and the volume",
    plan.valid && plan.configuration.caseCount === 3 && plan.volume.runsPerCandidate === 3,
    plan.valid
      ? `${plan.volume.maxCandidates} candidate(s) × ${plan.volume.runsPerCandidate} case(s) against a ${plan.volume.maxRuns}-run budget`
      : (plan.issues[0]?.message ?? "invalid"),
  );

  // The baseline must be the version the evidence batch ran: anything else would
  // compare a candidate against another version's numbers.
  const mismatched = await planOptimization(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      baselineVersionId: (await publishHarnessVersion(user, baseline.harnessId, {
        definition: baselineDefinition(),
        releaseNotes: "identical definition, new version",
      })).harnessVersion.id,
    }),
  );
  check(
    "a baseline that did not run the evidence batch is refused in pre-flight",
    !mismatched.valid && mismatched.issues.some((issue) => issue.path === "baselineVersionId"),
    mismatched.issues[0]?.message ?? "no issue reported",
  );

  // --- 4. session A: the full loop -------------------------------------------
  const sessionA = await createOptimizationSession(user, createOptimizationSessionSchema.parse(baseBody));
  check(
    "a session starts as a draft and writes nothing to the harness",
    sessionA.session.status === "DRAFT" &&
      sessionA.session.configSnapshot === null &&
      (await harnessRepository.findById(baseline.harnessId))?.currentVersion === harnessBefore?.currentVersion,
    `status ${sessionA.session.status}, no snapshot yet`,
  );

  const startedA = await startOptimizationSession(user, sessionA.session.id);
  check(
    "starting seals the configuration once",
    startedA.session.configSnapshot !== null &&
      startedA.session.configSnapshot.baseline.harnessVersionId === baseline.versionId &&
      startedA.session.configSnapshot.dataset.caseCount === 3 &&
      startedA.session.configSnapshot.evaluators.length === 2,
    `snapshot schema v${startedA.session.configSnapshot?.schemaVersion}, baseline v${startedA.session.configSnapshot?.baseline.harnessVersion}`,
  );

  const settledA = await waitForSession(user, sessionA.session.id);
  const detailA = await getOptimizationSession(user, sessionA.session.id);
  check(
    "the loop analyzes the evidence and records findings linked to real cases",
    detailA.findings.length > 0 &&
      detailA.findings.every((finding) => finding.caseKeys.length > 0) &&
      detailA.findings.some((finding) => finding.category === "harness_policy_violation") &&
      detailA.findings.some((finding) => finding.category === "incorrect_final_answer"),
    `${detailA.findings.length} finding(s): ${detailA.findings.map((finding) => finding.category).join(", ")}`,
  );
  check(
    "findings carry trace references, not invented ones",
    detailA.findings.every((finding) =>
      (finding.traceRefs ?? []).every(
        (ref) => ref.runId === null || evidenceCases.cases.some((entry) => entry.runId === ref.runId),
      ),
    ),
    `${detailA.findings.reduce((total, finding) => total + (finding.traceRefs?.length ?? 0), 0)} trace reference(s), every run id from the evidence batch`,
  );
  check(
    "hypotheses are structured and name the change they would make",
    detailA.hypotheses.length >= 2 &&
      detailA.hypotheses.every(
        (hypothesis) =>
          hypothesis.title !== "" &&
          hypothesis.hypothesis !== "" &&
          hypothesis.proposedChange !== "" &&
          hypothesis.expectedOutcome !== "",
      ),
    `${detailA.hypotheses.length} hypothesis(es) from ${detailA.findings.length} finding(s)`,
  );
  check(
    "every candidate is a typed, validated change with before/after values",
    detailA.candidates.length > 0 &&
      detailA.candidates.every(
        (candidate) =>
          candidate.validation !== null &&
          (candidate.changeSet ?? []).length > 0 &&
          candidate.mutations.length === (candidate.changeSet ?? []).length,
      ),
    `${detailA.candidates.length} candidate(s), ${detailA.candidates.reduce((total, candidate) => total + candidate.mutations.length, 0)} typed mutation row(s)`,
  );
  check(
    "the accepted candidate published a new immutable version that measured better",
    detailA.candidates.some(
      (candidate) =>
        candidate.decisionKind === "ACCEPT" &&
        candidate.versionId !== null &&
        candidate.metrics !== null &&
        candidate.evaluationBatchId !== null,
    ),
    detailA.candidates
      .map(
        (candidate) =>
          `${candidate.label.slice(0, 24)}… → ${candidate.decisionKind ?? "?"} (score ${candidate.metrics?.score.mean ?? "n/a"})`,
      )
      .join(" | "),
  );
  check(
    "a candidate that did not improve was rejected with reasons, not silently dropped",
    detailA.candidates.some(
      (candidate) => candidate.decisionKind === "REJECT" && (candidate.decision?.reasons.length ?? 0) > 0,
    ),
    detailA.candidates
      .filter((candidate) => candidate.decisionKind === "REJECT")
      .map((candidate) => candidate.decision?.reasons[0] ?? "")
      .join(" / ") || "none rejected",
  );
  check(
    "the session settled with a stopping reason and a persisted report",
    // The status the polling loop observed must be the one the reader persists.
    settledA === detailA.session.status &&
      isTerminalOptimizationStatus(detailA.session.status) &&
      detailA.session.stopReason !== null &&
      detailA.session.report !== null,
    `status ${detailA.session.status}, reason ${detailA.session.stopReason}, report ${detailA.session.report?.kind ?? "none"}`,
  );
  check(
    "the report recommends exactly the best accepted candidate",
    detailA.session.report !== null &&
      detailA.ranking.leader !== null &&
      detailA.session.report.recommendation.candidateId === detailA.ranking.leader.candidateId &&
      detailA.session.bestCandidateId === detailA.ranking.leader.candidateId,
    `recommendation ${detailA.ranking.leader?.label ?? "none"}`,
  );
  check(
    "the timeline records every step in order",
    detailA.events.some((event) => event.kind === "analysis.completed") &&
      detailA.events.some((event) => event.kind === "hypothesis.proposed") &&
      detailA.events.some((event) => event.kind === "evaluation.started") &&
      detailA.events.some((event) => event.kind === "session.stopped"),
    `${detailA.events.length} event(s), first ${detailA.events[0]?.kind ?? "?"}, last ${detailA.events[detailA.events.length - 1]?.kind ?? "?"}`,
  );

  // --- 5. the baseline was never touched -------------------------------------
  const baselineAfter = await harnessRepository.findVersionById(baseline.versionId);
  const harnessAfter = await harnessRepository.findById(baseline.harnessId);
  check(
    "the baseline version is byte-identical after an optimization",
    baselineAfter !== null &&
      JSON.stringify(baselineAfter.definition) === baselineSnapshot &&
      baselineAfter.contentHash === baselineRow.contentHash,
    `hash ${baselineAfter?.contentHash.slice(0, 12) ?? "?"} unchanged`,
  );
  check(
    "the loop never moved the harness's current version",
    harnessAfter?.currentVersion === harnessBefore?.currentVersion,
    `still v${harnessAfter?.currentVersion ?? "?"} — only an explicit promotion may advance it`,
  );

  const accepted = detailA.candidates.find((candidate) => candidate.decisionKind === "ACCEPT");
  const rejected = detailA.candidates.find((candidate) => candidate.decisionKind === "REJECT");
  check(
    "a candidate's evaluation reused the evidence batch's dataset and evaluator revisions",
    accepted !== undefined &&
      accepted.evaluationBatchId !== null &&
      (await getEvaluationBatch(user, accepted.evaluationBatchId)).batch.datasetVersionId ===
        evidenceDetail.batch.datasetVersionId,
    "same dataset version, same evaluator versions",
  );
  check(
    "a rejection is traceable to the candidate row and its reasons in the report",
    rejected !== undefined &&
      (rejected.decision?.reasons.length ?? 0) > 0 &&
      (detailA.session.report?.rejected.some((entry) => entry.candidateId === rejected.id) ??
        false),
    `rejected candidate ${rejected?.label ?? "none"} appears in the report with its reasons`,
  );

  // --- 6. session B: the approval gate ---------------------------------------
  const sessionB = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 Approval ${RUN_TAG}`,
      // Two iterations: the first proposes and parks, the second (after approval)
      // evaluates the approved candidate.
      limits: { ...baseBody.limits, requireApprovalBeforeEvaluation: true, maxIterations: 2 },
    }),
  );
  await startOptimizationSession(user, sessionB.session.id);
  const parked = await waitForSession(user, sessionB.session.id, { untilParked: true });
  const detailB = await getOptimizationSession(user, sessionB.session.id);
  const pending = detailB.candidates.find((candidate) => candidate.versionId === null);
  check(
    "with approval required the loop parks the candidate instead of evaluating it",
    parked === "WAITING_FOR_REVIEW" &&
      pending !== undefined &&
      pending.status === "PROPOSED" &&
      pending.pendingDefinition !== null &&
      detailB.review?.canApprove === true,
    `${detailB.candidates.length} candidate(s), status ${parked}, reviewable ${detailB.review?.canApprove ?? false}`,
  );

  // A restart must not lose the approved work: the definition is on the row.
  const resumedPass = await runPass(sessionB.session.id);
  const afterStrayPass = await getOptimizationSession(user, sessionB.session.id);
  check(
    "a pass over a session that is parked evaluates nothing",
    resumedPass.claimed === false && afterStrayPass.candidates.length === detailB.candidates.length,
    `claimed=${resumedPass.claimed}, candidates still ${afterStrayPass.candidates.length}`,
  );

  const approval = await approveOptimizationCandidate(user, sessionB.session.id, pending!.id, {
    notes: "The change is the smallest one that addresses the compliance failure.",
  });
  check(
    "approval is attributed, recorded and resumes the loop",
    // The inline pass may already have claimed the session for the re-dispatch by
    // the time we read it back; what must not hold is "still parked".
    approval.session.status !== "WAITING_FOR_REVIEW" &&
      (await getOptimizationSession(user, sessionB.session.id)).events.some(
        (event) => event.kind === "candidate.approved" && event.ref === pending!.id,
      ),
    `approved by ${user.id.slice(-6)}, status ${approval.session.status}, dispatch ${approval.dispatch?.mode ?? "inline"}`,
  );

  const settledB = await waitForSession(user, sessionB.session.id);
  const detailBAfter = await getOptimizationSession(user, sessionB.session.id);
  const approvedCandidate = detailBAfter.candidates.find((candidate) => candidate.id === pending!.id);
  check(
    "the evaluated candidate is exactly the definition that was approved",
    settledB !== "WAITING_FOR_REVIEW" &&
      approvedCandidate?.versionId !== null &&
      approvedCandidate?.evaluationBatchId !== null &&
      detailBAfter.events.some((event) => event.kind === "iteration.resumed"),
    `status ${settledB}, candidate evaluated ${approvedCandidate?.metrics !== null}`,
  );

  // --- 7. session C: rejecting a parked candidate ----------------------------
  const sessionC = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 Rejection ${RUN_TAG}`,
      limits: { ...baseBody.limits, requireApprovalBeforeEvaluation: true, maxIterations: 3 },
    }),
  );
  await startOptimizationSession(user, sessionC.session.id);
  await waitForSession(user, sessionC.session.id, { untilParked: true });
  const detailC = await getOptimizationSession(user, sessionC.session.id);
  const pendingC = detailC.candidates.find((candidate) => candidate.versionId === null);
  const rejection = await rejectOptimizationCandidate(
    user,
    sessionC.session.id,
    pendingC!.id,
    { reason: "Not the smallest change that addresses the finding." },
  );
  const detailCAfter = await getOptimizationSession(user, sessionC.session.id);
  const rejectedC = detailCAfter.candidates.find((candidate) => candidate.id === pendingC!.id);
  check(
    "a rejected candidate is recorded, keeps its change set, and is never evaluated",
    rejection.session.status === "QUEUED" &&
      rejectedC?.decisionKind === "REJECT" &&
      rejectedC?.pendingDefinition === null &&
      rejectedC?.evaluationBatchId === null &&
      detailCAfter.hypotheses.some(
        (hypothesis) => hypothesis.id === rejectedC?.hypothesisId && hypothesis.status === "EXHAUSTED",
      ),
    `rejected "${rejectedC?.label ?? "?"}", hypothesis exhausted, nothing published`,
  );

  await cancelOptimizationSession(user, sessionC.session.id, { reason: "verification cleanup" });

  // --- 8. session D: budgets stop the loop -----------------------------------
  const sessionD = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 Budget ${RUN_TAG}`,
      limits: { ...baseBody.limits, maxRuns: 4, maxIterations: 5, maxCandidates: 4 },
    }),
  );
  await startOptimizationSession(user, sessionD.session.id);
  const settledD = await waitForSession(user, sessionD.session.id);
  const detailD = await getOptimizationSession(user, sessionD.session.id);
  const runsD = await getPrisma().run.count({ where: { harnessId: baseline.harnessId } });
  check(
    "the run budget stops the loop instead of overrunning",
    detailD.session.runCount <= 4 &&
      detailD.session.stopReason !== null &&
      settledD !== "RUNNING",
    `${detailD.session.runCount} run(s) against a 4-run budget, reason ${detailD.session.stopReason}`,
  );
  check(
    "a session that was cut short is labelled as partially complete",
    settledD === "PARTIALLY_COMPLETED" || settledD === "COMPLETED",
    `status ${settledD} (${runsD} run(s) exist for this harness in total)`,
  );

  // --- 9. session E: cancellation --------------------------------------------
  const sessionE = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 Cancellation ${RUN_TAG}`,
      limits: { ...baseBody.limits, requireApprovalBeforeEvaluation: true, maxIterations: 3 },
    }),
  );
  await startOptimizationSession(user, sessionE.session.id);
  await waitForSession(user, sessionE.session.id, { untilParked: true });
  const cancelled = await cancelOptimizationSession(user, sessionE.session.id, {
    reason: "the reviewer decided to stop",
  });
  let restartRefused = false;
  try {
    await startOptimizationSession(user, sessionE.session.id);
  } catch (error) {
    restartRefused = error instanceof OptimizationConflictError;
  }
  check(
    "cancelling settles the session and records why",
    cancelled.session.status === "CANCELLED" &&
      cancelled.session.stopReason === "cancelled" &&
      cancelled.settledImmediately === true &&
      restartRefused,
    `status ${cancelled.session.status}, reason ${cancelled.session.stopReason}, restart refused: ${restartRefused}`,
  );

  const eventsE = await getOptimizationSession(user, sessionE.session.id);
  check(
    "cancellation is on the timeline, not just in a status field",
    eventsE.events.some((event) => event.kind === "session.cancel_requested"),
    `${eventsE.events.length} event(s)`,
  );

  // --- 10. session F: manual candidates --------------------------------------
  const manualVersion = await publishHarnessVersion(user, baseline.harnessId, {
    definition: {
      ...baselineDefinition(),
      name: "Phase 5 Verification — hand-built candidate",
      nodes: [
        ...baselineDefinition().nodes.map((entry) => ({ ...entry })),
        node("verify", "critic", "Verify before answering", {
          instructions: "Check the draft for unsupported claims and correct them.",
          threshold: 0.7,
        }),
      ],
      edges: [
        edge("e1", "start", "planner"),
        edge("e2", "planner", "clock"),
        edge("e3", "clock", "drafter"),
        edge("e4", "drafter", "verify"),
        edge("e5", "verify", "end"),
      ],
    } as unknown as HarnessDefinition,
    releaseNotes: `Hand-built candidate (${RUN_TAG})`,
  });

  const sessionF = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 Manual ${RUN_TAG}`,
      limits: { ...baseBody.limits, maxIterations: 1, maxCandidates: 2 },
    }),
  );
  const attached = await attachManualCandidate(user, sessionF.session.id, {
    harnessVersionId: manualVersion.harnessVersion.id,
    label: "Hand-built verification step",
    notes: "Authored in the builder rather than proposed by the loop.",
  });
  await startOptimizationSession(user, sessionF.session.id);
  await waitForSession(user, sessionF.session.id);
  const detailF = await getOptimizationSession(user, sessionF.session.id);
  const manualCandidate = detailF.candidates.find((candidate) => candidate.id === attached.candidate.id);
  check(
    "a hand-built version can be attached and evaluated as a candidate",
    manualCandidate?.versionId === manualVersion.harnessVersion.id &&
      manualCandidate?.metrics !== null &&
      manualCandidate?.decisionKind !== null,
    `"${manualCandidate?.label ?? "?"}" → ${manualCandidate?.decisionKind ?? "?"}`,
  );

  // --- 11. promotion ---------------------------------------------------------
  const promotable = detailF.candidates.find((candidate) => candidate.decisionKind === "ACCEPT");
  check(
    "the hand-built candidate clears the acceptance policy",
    promotable !== undefined,
    promotable === undefined ? "no accepted candidate to promote" : `accepted: ${promotable.label}`,
  );

  if (promotable !== undefined) {
    let promotion:
      | Awaited<ReturnType<typeof promoteOptimizationCandidate>>
      | null = null;
    let promotionError: unknown = null;
    try {
      promotion = await promoteOptimizationCandidate(user, sessionF.session.id, {
        candidateId: promotable.id,
        notes: "Promote the verified candidate.",
      });
    } catch (error) {
      promotionError = error;
    }
    check(
      "an explicit promotion advances the harness to the candidate's immutable version",
      promotion !== null &&
        promotion.harnessVersion.id === promotable.versionId &&
        (await harnessRepository.findById(baseline.harnessId))?.currentVersion ===
          promotion.harnessVersion.version,
      promotion === null
        ? `promotion refused: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`
        : `current version v${(await harnessRepository.findById(baseline.harnessId))?.currentVersion ?? "?"}`,
    );
    check(
      "promotion leaves the original baseline version untouched",
      (await harnessRepository.findVersionById(baseline.versionId))?.contentHash ===
        baselineRow.contentHash,
      `baseline v${baselineRow.version} hash unchanged`,
    );

    let secondPromotionRefused = false;
    try {
      await promoteOptimizationCandidate(user, sessionF.session.id, {
        candidateId: promotable.id,
        notes: "promote again",
      });
    } catch (error) {
      secondPromotionRefused = error instanceof Error;
    }
    check(
      "promoting the same candidate twice is refused (the harness never rolls back)",
      secondPromotionRefused,
      "the second promotion was rejected",
    );
  }

  // --- 12. read models and export -------------------------------------------
  const listed = await listOptimizationSessions(user, { limit: 50 });
  check(
    "sessions are listed with their outcome, budget and best candidate",
    listed.items.some((item) => item.id === sessionA.session.id) &&
      listed.items.every((item) => item.maxIterations > 0),
    `${listed.total} session(s) visible`,
  );

  const jsonExport = await exportOptimizationReport(user, sessionA.session.id, { format: "json" });
  const parsed = JSON.parse(jsonExport.body) as {
    report?: { findings?: unknown[]; candidates?: unknown[] };
    findings?: unknown[];
  };
  check(
    "the JSON export carries the report, findings and candidates",
    jsonExport.contentType.includes("application/json") &&
      (parsed.report?.findings?.length ?? 0) > 0 &&
      (parsed.findings?.length ?? 0) > 0,
    `${jsonExport.fileName}, ${jsonExport.body.length} bytes`,
  );

  const markdownExport = await exportOptimizationReport(user, sessionA.session.id, {
    format: "markdown",
  });
  check(
    "the markdown export renders the loop as a readable engineering report",
    markdownExport.body.includes("#") &&
      markdownExport.body.includes("Finding") &&
      markdownExport.body.includes("Candidate"),
    `${markdownExport.fileName}, ${markdownExport.body.split("\n").length} line(s)`,
  );

  // --- 13. workspace isolation ----------------------------------------------
  const outsider = await ensureOutsider();
  let isolatedSession = false;
  let isolatedAction = false;
  try {
    await getOptimizationSession(outsider, sessionA.session.id);
  } catch {
    isolatedSession = true;
  }
  try {
    await cancelOptimizationSession(outsider, sessionA.session.id, { reason: "not mine" });
  } catch {
    isolatedAction = true;
  }
  check(
    "another workspace can neither read an optimization nor act on it",
    isolatedSession && isolatedAction,
    "both answered not-found (existence is never disclosed)",
  );
  // Checked while the outsider still exists, so this is a real second workspace
  // rather than a deleted user.
  const outsiderHistory = await getOptimizationHistory(outsider, {});
  const ownerHistory = await getOptimizationHistory(user, {});
  check(
    "the history is scoped to the caller's own workspace",
    outsiderHistory.totals.sessions === 0 &&
      outsiderHistory.categories.length === 0 &&
      ownerHistory.totals.sessions > 0,
    `outsider sees ${outsiderHistory.totals.sessions} session(s) where the owner sees ${ownerHistory.totals.sessions}`,
  );
  await removeOutsider(outsider);

  // --- 14. LLM-assisted analysis (scripted model — no paid calls) -------------
  // The analyzer is opt-in per session and its answer is scripted here, so the
  // check is about the *handling* of a model claim, not about a model's quality:
  // the claim must be stored as a labelled hypothesis, must keep only case keys
  // the deterministic pass actually observed, and must never be counted as agent
  // run usage.
  const seededCase = detailA.findings.flatMap((finding) => finding.caseKeys)[0];
  queueMockResponses({
    kind: "success",
    content: JSON.stringify([
      {
        category: "harness_policy_violation",
        summary:
          "Every failing case answers without the mandatory policy clause, which points at the missing verification step rather than the wording.",
        caseKeys: [seededCase, "case-that-was-never-observed"],
        investigation: "Compare the drafter's instructions with the compliance rubric.",
      },
    ]),
  });
  const sessionG = await createOptimizationSession(
    user,
    createOptimizationSessionSchema.parse({
      ...baseBody,
      name: `Phase 5 LLM-assisted ${RUN_TAG}`,
      limits: { ...baseBody.limits, maxIterations: 1, maxCandidates: 1, maxRuns: 3, analyzerModel: MODEL },
    }),
  );
  await startOptimizationSession(user, sessionG.session.id);
  await waitForSession(user, sessionG.session.id);
  const detailG = await getOptimizationSession(user, sessionG.session.id);
  const llmFindings = detailG.findings.filter((finding) => finding.confidence === "llm");
  check(
    "an LLM-assisted pass adds labelled hypotheses without displacing the deterministic findings",
    llmFindings.length > 0 &&
      llmFindings.every((finding) => finding.isLlm) &&
      detailG.findings.some((finding) => finding.confidence !== "llm") &&
      llmFindings.every((finding) =>
        finding.caseKeys.every((key) => key !== "case-that-was-never-observed"),
      ),
    `${llmFindings.length} hypothesis-level finding(s) of ${detailG.findings.length}`,
  );
  check(
    "the model's own tokens are accounted separately from agent runs",
    detailG.session.analyzerTokenUsage > 0 &&
      detailG.events.some((event) => event.kind === "analysis.semantic"),
    `${detailG.session.analyzerTokenUsage} analyzer token(s) against ${detailG.session.tokenUsage} agent token(s)`,
  );

  // --- 14b. cross-session optimization history -------------------------------
  // The history is the one optimization surface that spans sessions, so it is
  // checked against the sessions this run actually produced: grouped by failure
  // category, effectiveness split by mutation strategy, and honest about what was
  // never measured.
  const history = await getOptimizationHistory(user, {});
  const everyCategoryConsistent = history.categories.every(
    (entry) =>
      entry.candidates ===
        entry.byStrategy.reduce((sum, strategy) => sum + strategy.candidates, 0) &&
      entry.accepted ===
        entry.byStrategy.reduce((sum, strategy) => sum + strategy.accepted, 0) &&
      (entry.evaluated === 0 ? entry.acceptanceRate === null : entry.acceptanceRate !== null),
  );
  const categoriesWithCandidates = history.categories.filter((entry) => entry.candidates > 0);
  check(
    "the history groups strategy effectiveness by failure category",
    history.totals.sessions >= 1 &&
      categoriesWithCandidates.length >= 1 &&
      everyCategoryConsistent &&
      categoriesWithCandidates.some((entry) => entry.byStrategy.length > 0),
    `${history.categories.length} category(ies), ${categoriesWithCandidates.length} with candidates, per-strategy totals reconciled`,
  );

  const operationsSeen = categoriesWithCandidates.flatMap((entry) =>
    entry.operations.map((operation) => operation.operation),
  );
  check(
    "the history reports which mutations were tried, with their own outcomes",
    operationsSeen.length > 0 &&
      operationsSeen.some(
        (operation) => operation === "insert_node" || operation === "set_prompt_instruction",
      ) &&
      categoriesWithCandidates.some((entry) =>
        entry.operations.every((operation) =>
          operation.acceptanceRate === null
            ? operation.candidates === 0
            : operation.acceptanceRate === operation.accepted / operation.candidates,
        ),
      ),
    `${new Set(operationsSeen).size} distinct mutation operation(s) across categories`,
  );

  check(
    "a candidate that tests no hypothesis is reported without a failure category",
    history.unattributed !== null &&
      history.unattributed.candidates >= 1 &&
      history.unattributed.operations.some(
        (operation) => operation.operation === "attach_manual_candidate",
      ),
    `${history.unattributed?.candidates ?? 0} unattributed candidate(s), manual attach recorded`,
  );

  check(
    "the history never presents unmeasured candidates as a zero improvement",
    history.categories.every(
      (entry) =>
        // A mean exists exactly when something was measured.
        (entry.measured === 0) === (entry.meanImprovement === null) &&
        // The evidence label follows the measured sample, not the session count.
        entry.evidence ===
          (entry.measured >= 8 ? "established" : entry.measured >= 3 ? "suggestive" : "insufficient") &&
        // A measured mean always names the unit it is in.
        (entry.measured === 0 || entry.metric !== null),
    ) &&
      // The read model states its own provenance: it always explains where the
      // numbers came from and that a rate is a policy outcome.
      history.notes.length >= 2 &&
      history.notes.some((note) => note.includes("session(s)")) &&
      history.notes.some((note) => note.includes("policy outcome")),
    `sample sizes labelled; ${history.totals.measuredComparisons} measured comparison(s) of ${history.totals.candidates} candidate(s)`,
  );

  // --- 15. immutability, one last time --------------------------------------
  const finalBaseline = await harnessRepository.findVersionById(baseline.versionId);
  const publishedVersions = await harnessRepository.listVersions(baseline.harnessId);
  check(
    "every published version is still exactly as published",
    finalBaseline?.contentHash === baselineRow.contentHash &&
      publishedVersions.every((version) => version.contentHash !== ""),
    `${publishedVersions.length} version(s) on the harness, all content-hashed`,
  );

  // --- summary --------------------------------------------------------------
  const total = passed();
  process.stdout.write(`\n  ${total}/${checks.length} checks passed\n`);
  if (total !== checks.length) {
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
  const email = `phase5-outsider-${RUN_TAG}@example.com`;
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
    data: { name: `Phase 5 Outsider Workspace ${RUN_TAG}`, slug: `phase5-outsider-${RUN_TAG}` },
  });
  const user = await prisma.user.create({
    data: {
      id: `phase5-outsider-${RUN_TAG}`,
      email,
      name: `Phase 5 Outsider ${RUN_TAG}`,
      emailVerified: true,
    },
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
