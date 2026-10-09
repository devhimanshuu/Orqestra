/**
 * Phase 2 verification — real database, real runtime, real persistence.
 *
 * Scenario (mirrors the Phase 2 spec's final verification):
 *
 *   START → LOOP → PLANNER → TOOL → CRITIC → CONDITION → END | LOOP
 *
 *   Research the benefits of TypeScript.
 *
 * and then the failure modes: invalid tool (compile), max iterations, retry,
 * cancellation, and immutability of history.
 *
 * The run is executed through the *production* path: run row → dispatcher →
 * run.executor → executeHarness → persisted steps/events/usage. Execution is
 * forced inline (`RUN_EXECUTION_MODE=inline`) so the script does not need Redis.
 *
 *   pnpm exec tsx scripts/verify-phase2.ts
 */

import { loadEnvFile } from "node:process";
import { getEnv } from "../src/config/env";
import type { AuthUser } from "../src/lib/auth/provider";
import { getPrisma } from "../src/lib/db/prisma";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import { runJobSchema } from "../src/modules/runtime/queues";
import { runRepository } from "../src/modules/runtime/run.repository";
import type { RunMetadata } from "../src/modules/runtime/run.types";
import { createRun, cancelRun, getRunDetail, retryRun } from "../src/modules/runtime/run.service";
import { processRunJob } from "../src/modules/runtime/worker";

try {
  loadEnvFile();
} catch {
  // Env may come from the shell.
}

process.env["RUN_EXECUTION_MODE"] = "inline";

const MODEL = "mock:deterministic";
const AGENT_NAME = "Phase 2 Verification Agent";
const HARNESS_NAME = "Verification Harness — research loop";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`  [${mark}] ${name} — ${detail}\n`);
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

/** The spec's research loop, with the required explicit Loop node on the cycle. */
function researchLoopDefinition(options: { maxIterations?: number } = {}): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "verification-research-loop",
    version: 1,
    name: HARNESS_NAME,
    description: "START → LOOP → PLANNER → TOOL → CRITIC → CONDITION → END | LOOP",
    nodes: [
      node("start", "start", "Start"),
      node("loop", "loop", "Refine loop", { maxIterations: options.maxIterations ?? 3 }),
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

/** A harness whose tool does not exist (must be refused at compile time). */
function brokenToolDefinition(): HarnessDefinition {
  const definition = researchLoopDefinition();
  return {
    ...definition,
    id: "verification-broken-tool",
    name: "Verification Harness — invalid tool",
    nodes: definition.nodes.map((entry) =>
      entry.id === "clock" ? { ...entry, config: { toolId: "does_not_exist" } } : entry,
    ),
  } as HarnessDefinition;
}

/** START → LOOP → MEMORY → CONDITION(never true) → LOOP | exit → END */
function loopExhaustionDefinition(): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "verification-loop-exhaustion",
    version: 1,
    name: "Verification Harness — loop exhaustion",
    nodes: [
      node("start", "start", "Start"),
      node("loop", "loop", "Accumulate", { maxIterations: 3 }),
      node("remember", "memory", "Remember", { scope: "run", maxItems: 10 }),
      node("gate", "condition", "Never satisfied", { expression: "state.memorySize >= 999" }),
      node("end", "end", "End"),
    ],
    edges: [
      edge("e0", "start", "loop"),
      edge("e1", "loop", "remember", "body"),
      edge("e2", "remember", "gate"),
      edge("e3", "gate", "loop", "false"),
      edge("e4", "gate", "end", "true"),
      edge("e5", "loop", "end", "exit"),
    ],
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

async function ensureAgent(user: AuthUser): Promise<{ id: string; version: number; model: string }> {
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

  const existing = await prisma.agent.findFirst({
    where: { projectId, name: AGENT_NAME },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (existing !== null) {
    const latest = existing.versions[0];
    return { id: existing.id, version: latest?.version ?? 1, model: MODEL };
  }

  const created = await prisma.agent.create({
    data: {
      projectId,
      name: AGENT_NAME,
      slug: "phase2-verification-agent",
      description: "Created by scripts/verify-phase2.ts",
      currentVersion: 1,
      versions: {
        create: {
          version: 1,
          purpose: "Verify the Phase 2 runtime end to end.",
          instructions:
            "You are a rigorous research agent. Plan, gather evidence, critique your own work, then answer.",
          modelConfig: { model: MODEL, temperature: 0.2 },
          capabilities: ["calculator", "json_transform", "current_time"],
          createdBy: user.id,
        },
      },
    },
    include: { versions: true },
  });
  return { id: created.id, version: created.versions[0]?.version ?? 1, model: MODEL };
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

async function waitForTerminal(runId: string, timeoutMs = 120_000): Promise<string> {
  const startedAt = Date.now();
  let status = "QUEUED";
  while (Date.now() - startedAt < timeoutMs) {
    const run = await runRepository.findById(runId);
    status = run?.status ?? "MISSING";
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return status;
}

async function main(): Promise<void> {
  process.stdout.write("\nORQESTRA — Phase 2 verification\n\n");

  const user = await resolveDemoUser();
  const agent = await ensureAgent(user);
  process.stdout.write(`  agent:     ${agent.id} (v${agent.version}, model ${agent.model})\n`);

  // --- 1. happy path: the spec's scenario ----------------------------------
  const research = await ensureHarness(
    user,
    agent.id,
    researchLoopDefinition({ maxIterations: 3 }),
    "verification-research-loop",
  );
  process.stdout.write(`  harness:   ${research.harnessId} (v${research.version})\n\n`);

  const { run: created, dispatch } = await createRun(user, {
    agentId: agent.id,
    harnessVersionId: research.versionId,
    input: "Research the benefits of TypeScript.",
  });
  check("run created", created.status === "QUEUED", `run ${created.id}, dispatch ${dispatch.mode}`);

  const status = await waitForTerminal(created.id);
  const detail = await getRunDetail(user, created.id);

  check("run completed", status === "SUCCEEDED", `status ${status}`);
  check(
    "job executed without an HTTP request",
    dispatch.mode === "inline",
    `${dispatch.mode} dispatcher (queue mode is exercised by pnpm worker)`,
  );

  const nodeOrder = detail.steps.map((step) => step.nodeId);
  check(
    "START executed",
    nodeOrder[0] === "start",
    `first step ${nodeOrder[0] ?? "none"}`,
  );
  check(
    "PLANNER executed",
    nodeOrder.includes("planner"),
    `order: ${nodeOrder.join(" → ")}`,
  );
  check("TOOL executed", nodeOrder.includes("clock"), "tool node ran (current_time)");
  check("CRITIC executed", nodeOrder.includes("critic"), "critic ran and scored the plan");
  check("CONDITION evaluated", nodeOrder.includes("gate"), "condition chose a branch");
  check(
    "correct path selected",
    detail.steps.find((step) => step.nodeId === "gate")?.metadata?.["branch"] === "true",
    `branch ${String(detail.steps.find((step) => step.nodeId === "gate")?.metadata?.["branch"] ?? "?")}`,
  );
  check("END executed", nodeOrder.at(-1) === "end", `last step ${nodeOrder.at(-1) ?? "none"}`);
  check(
    "trace persisted",
    detail.steps.length === nodeOrder.length && detail.events.length > nodeOrder.length,
    `${detail.steps.length} steps, ${detail.events.length} events`,
  );
  check(
    "loop iteration recorded",
    detail.steps.find((step) => step.nodeId === "loop")?.iteration === 1,
    `iteration ${String(detail.steps.find((step) => step.nodeId === "loop")?.iteration ?? "?")}`,
  );
  check(
    "token usage recorded",
    (detail.run.tokenUsage?.totalTokens ?? 0) > 0,
    `${detail.usageTotal.totalTokens} tokens across ${detail.usageTotal.calls} model calls`,
  );
  check(
    "cost estimated",
    detail.usageTotal.costUsd === 0,
    `cost ${detail.usageTotal.costUsd ?? "unknown"} (mock provider is free)`,
  );
  check(
    "run output persisted",
    detail.run.output !== null,
    `output: ${JSON.stringify(detail.run.output).slice(0, 90)}…`,
  );
  check(
    "reproducibility pins stored",
    detail.run.metadata?.harnessContentHash !== null &&
      detail.run.metadata?.engineVersion !== undefined,
    `engine ${detail.run.metadata?.engineVersion}, hash ${detail.run.metadata?.harnessContentHash?.slice(0, 12)}…`,
  );

  // --- 2. invalid tool (compile-time refusal) ------------------------------
  const broken = await ensureHarness(
    user,
    agent.id,
    brokenToolDefinition(),
    "verification-broken-tool",
  );
  let refused = false;
  let refusalMessage = "";
  try {
    await createRun(user, {
      agentId: agent.id,
      harnessVersionId: broken.versionId,
      input: "This must not start.",
    });
  } catch (error) {
    refused = true;
    refusalMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "invalid tool refused before execution",
    refused && refusalMessage.includes("not registered"),
    refusalMessage.slice(0, 110),
  );

  // --- 3. maximum iterations ---------------------------------------------
  const looping = await ensureHarness(
    user,
    agent.id,
    loopExhaustionDefinition(),
    "verification-loop-exhaustion",
  );
  const loopRun = await createRun(user, {
    agentId: agent.id,
    harnessVersionId: looping.versionId,
    input: "Loop until the budget is gone.",
    limits: { maxIterations: 2 },
  });
  const loopStatus = await waitForTerminal(loopRun.run.id);
  const loopDetail = await getRunDetail(user, loopRun.run.id);
  check(
    "maximum iterations enforced",
    loopStatus === "FAILED" && loopDetail.run.error?.code === "MAX_ITERATIONS_EXCEEDED",
    `${loopStatus} / ${loopDetail.run.error?.code ?? "no error"}`,
  );

  // --- 4. retry creates a new immutable run -------------------------------
  const retried = await retryRun(user, created.id);
  const retryStatus = await waitForTerminal(retried.run.id);
  const originalAfter = await runRepository.findById(created.id);
  check(
    "retry creates a new run",
    retried.run.id !== created.id && retried.run.retryOfRunId === created.id,
    `#${retried.run.id.slice(-6)} ← retry of #${created.id.slice(-6)} (attempt ${retried.run.attempt})`,
  );
  check("retried run completes", retryStatus === "SUCCEEDED", `status ${retryStatus}`);
  check(
    "history stays immutable",
    originalAfter?.status === "SUCCEEDED" && originalAfter.retryOfRunId === null,
    `original still ${originalAfter?.status}`,
  );

  // --- 5. cancellation ----------------------------------------------------
  const queued = await runRepository.create({
    harnessId: research.harnessId,
    harnessVersionId: research.versionId,
    input: "Cancelled before it starts.",
    agentId: agent.id,
    agentVersion: agent.version,
    metadata: {
      engineVersion: "orqestra-runtime/0.2.0",
      harnessContentHash: null,
      harnessVersion: research.version,
      nodeCount: 0,
      edgeCount: 0,
      nodeTypes: [],
      model: MODEL,
      provider: "mock",
      limits: {
        maxDurationMs: 120_000,
        maxNodes: 100,
        maxIterations: 10,
        maxToolCalls: 20,
        maxLlmCalls: 30,
        maxCostUsd: null,
      },
      allowedTools: ["current_time"],
      executionMode: "unknown",
    },
  });
  const cancelled = await cancelRun(user, queued.id);
  check(
    "cancellation marks a queued run cancelled",
    cancelled.status === "CANCELLED",
    `status ${cancelled.status}, requestedAt ${cancelled.cancelRequestedAt?.toISOString() ?? "—"}`,
  );

  // --- 6. worker path: the BullMQ processor executes a queued run ---------
  //
  // Redis is not required for this check: `processRunJob` is exactly what the
  // BullMQ Worker invokes with each job, so running it here proves the worker
  // half of the pipeline (load → compile → execute → persist) against the real
  // database. Only the transport itself (Redis) stays untested locally.
  // The snapshot the queue worker's runs are pinned to (same shape the run
  // service writes, with the queue transport recorded).
  const workerMetadata: RunMetadata = {
    engineVersion: detail.run.metadata?.engineVersion ?? "orqestra-runtime/0.2.0",
    harnessContentHash: detail.run.metadata?.harnessContentHash ?? null,
    harnessVersion: research.version,
    nodeCount: detail.run.metadata?.nodeCount ?? 0,
    edgeCount: detail.run.metadata?.edgeCount ?? 0,
    nodeTypes: detail.run.metadata?.nodeTypes ?? [],
    model: MODEL,
    provider: "mock",
    limits: {
      maxDurationMs: 120_000,
      maxNodes: 100,
      maxIterations: 10,
      maxToolCalls: 20,
      maxLlmCalls: 30,
      maxCostUsd: null,
    },
    allowedTools: [],
    executionMode: "queue",
  };

  const jobPayload = { runId: "placeholder", harnessVersionId: research.versionId };
  const acceptsJobs =
    runJobSchema.safeParse(jobPayload).success &&
    !runJobSchema.safeParse({ runId: "missing-version" }).success;
  check(
    "job payload contract validated",
    acceptsJobs,
    "worker accepts {runId, harnessVersionId} and rejects malformed jobs",
  );

  const workerRun = await runRepository.create({
    harnessId: research.harnessId,
    harnessVersionId: research.versionId,
    input: "Executed by the queue worker.",
    agentId: agent.id,
    agentVersion: agent.version,
    metadata: workerMetadata,
  });
  const accepted = await processRunJob({
    runId: workerRun.id,
    harnessVersionId: research.versionId,
  });
  const workerDetail = await getRunDetail(user, workerRun.id);
  check(
    "worker processor executed a queued run",
    accepted.accepted && workerDetail.run.status === "SUCCEEDED",
    `job accepted, run ${workerDetail.run.status} with ${workerDetail.steps.length} steps`,
  );
  check(
    "worker run persisted trace and usage",
    workerDetail.events.length > 0 && workerDetail.usageTotal.totalTokens > 0,
    `${workerDetail.events.length} events, ${workerDetail.usageTotal.totalTokens} tokens, cost ${workerDetail.usageTotal.costUsd ?? "unknown"}`,
  );
  check(
    "transport recorded on the run",
    workerDetail.run.metadata?.executionMode === "queue",
    `executionMode ${String(workerDetail.run.metadata?.executionMode)}`,
  );

  // Delivery is at-least-once, so the same job may arrive twice.
  const redelivered = await processRunJob({
    runId: workerRun.id,
    harnessVersionId: research.versionId,
  });
  const afterRedelivery = await runRepository.findByIdWithSteps(workerRun.id);
  check(
    "duplicate delivery cannot execute a run twice",
    redelivered.accepted &&
      afterRedelivery?.status === "SUCCEEDED" &&
      afterRedelivery.steps.length === workerDetail.steps.length,
    `${afterRedelivery?.steps.length ?? 0} steps after redelivery (unchanged)`,
  );

  // --- 7. a running worker observes cancellation ---------------------------
  const longRun = await runRepository.create({
    harnessId: research.harnessId,
    harnessVersionId: research.versionId,
    input: "Cancelled mid-flight.",
    agentId: agent.id,
    agentVersion: agent.version,
    metadata: workerMetadata,
  });
  const inFlight = processRunJob({ runId: longRun.id, harnessVersionId: research.versionId });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const midRun = await runRepository.findByIdWithSteps(longRun.id);
  check(
    "worker was mid-run when cancellation arrived",
    midRun?.status === "RUNNING",
    `status ${midRun?.status} with ${midRun?.steps.length ?? 0} of ${workerDetail.steps.length} steps traced`,
  );
  await cancelRun(user, longRun.id);
  await inFlight;
  const cancelledRun = await runRepository.findByIdWithSteps(longRun.id);
  check(
    "running worker stops when cancellation is requested",
    cancelledRun?.status === "CANCELLED",
    `status ${cancelledRun?.status} — stopped after ${cancelledRun?.steps.length ?? 0} of ${workerDetail.steps.length} steps`,
  );
  check(
    "cancelled run kept the steps it had already traced",
    (cancelledRun?.steps.length ?? 0) > 0 &&
      (cancelledRun?.steps.length ?? 0) < workerDetail.steps.length,
    `${cancelledRun?.steps.length ?? 0} steps persisted before the runtime stopped`,
  );

  // --- summary ------------------------------------------------------------
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

// The script talks to Postgres and (optionally) Redis; it exits explicitly so a
// lingering infrastructure socket can never hang CI.
main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nverification crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  })
  .finally(() => {
    void import("../src/lib/redis/connection").then(({ closeRedis }) => closeRedis()).catch(() => undefined);
  });
