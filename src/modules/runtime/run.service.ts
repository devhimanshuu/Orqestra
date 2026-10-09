import type { AuthUser } from "@/lib/auth/provider";
import { NotFoundError, ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { assertAgentAccess, assertHarnessAccess } from "@/modules/access/access.service";
import { agentRepository } from "@/modules/agents/agent.repository";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { HarnessConflictError } from "@/modules/harness/harness.types";
import { compileHarness, previewHarnessCompilation } from "./compiler";
import type { ExecutionPreview } from "./compiler";
import { RUNTIME_ENGINE_VERSION } from "./runtime";
import { DEFAULT_RUNTIME_LIMITS } from "./state/execution-state";
import type { RuntimeExecutionLimits } from "./state/execution-state";
import { runRepository } from "./run.repository";
import { dispatchRun, type DispatchResult } from "./run.dispatcher";
import { requestRunCancellation, clearRunCancellation } from "./events/bus";
import type {
  CreateRunInput,
  Run,
  RunDetail,
  RunListPage,
  RunListItem,
  RunMetadata,
  RunStatus,
  RuntimeUsageRecord,
} from "./run.types";
import { RunConflictError, RunNotFoundError } from "./run.types";
import type { CreateRunBody, ListRunsQuery } from "./run.inputs";
import { workspaceRepository } from "@/modules/projects/workspace.repository";
import { projectRepository } from "@/modules/projects/project.repository";

const serviceLogger = logger.child({ module: "runtime.runs" });

/**
 * Run service — the only entry point for run operations.
 *
 * Authorization chain (never trusting client ids):
 *   user → workspace → project → agent → harness → harness version
 *
 * Reproducibility: every run pins the harness version, the agent version, the
 * engine version, the harness content hash, the limits and the provider refs.
 * Historical runs are immutable; retry creates a new run that points back.
 */

const TERMINAL_STATUSES: RunStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Clamps caller-provided budgets to the platform ceilings. */
export function resolveLimits(overrides: Partial<RuntimeExecutionLimits> | undefined): RuntimeExecutionLimits {
  return {
    maxDurationMs: Math.min(
      overrides?.maxDurationMs ?? DEFAULT_RUNTIME_LIMITS.maxDurationMs,
      DEFAULT_RUNTIME_LIMITS.maxDurationMs * 5,
    ),
    maxNodes: Math.min(overrides?.maxNodes ?? DEFAULT_RUNTIME_LIMITS.maxNodes, 1_000),
    maxIterations: Math.min(overrides?.maxIterations ?? DEFAULT_RUNTIME_LIMITS.maxIterations, 100),
    maxToolCalls: Math.min(overrides?.maxToolCalls ?? DEFAULT_RUNTIME_LIMITS.maxToolCalls, 200),
    maxLlmCalls: Math.min(overrides?.maxLlmCalls ?? DEFAULT_RUNTIME_LIMITS.maxLlmCalls, 300),
    maxCostUsd: overrides?.maxCostUsd ?? DEFAULT_RUNTIME_LIMITS.maxCostUsd,
  };
}

function modelParts(ref: string | null): { model: string | null; provider: string | null } {
  if (ref === null) {
    return { model: null, provider: null };
  }
  const separator = ref.indexOf(":");
  return separator <= 0
    ? { model: ref, provider: null }
    : { provider: ref.slice(0, separator), model: ref.slice(separator + 1) };
}

export interface CreatedRun {
  run: Run;
  dispatch: DispatchResult;
}

/**
 * Creates and dispatches a run. The run row exists before the job is enqueued,
 * so the queue payload always references durable state.
 */
export async function createRun(user: AuthUser, body: CreateRunBody): Promise<CreatedRun> {
  const agent = await assertAgentAccess(user.id, body.agentId);

  const harnessVersion = await harnessRepository.findVersionById(body.harnessVersionId);
  if (harnessVersion === null) {
    throw new NotFoundError("Harness version not found");
  }
  const harness = await assertHarnessAccess(user.id, harnessVersion.harnessId);

  // The version must belong to a harness of *this* agent: a client cannot
  // execute one agent's harness under another agent's identity or config.
  if (harness.agentId !== agent.id) {
    throw new ConflictError("That harness version does not belong to this agent");
  }

  const compiled = compileHarness(harnessVersion.definition);
  if (!compiled.ok) {
    throw new HarnessConflictError(
      `This harness version is not executable: ${compiled.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const limits = resolveLimits(body.limits);
  const agentVersion = await agentRepository.findLatestVersion(agent.id);
  const providerRef = agentVersion?.modelConfig.model ?? null;
  const metadata: RunMetadata = {
    engineVersion: RUNTIME_ENGINE_VERSION,
    harnessContentHash: harnessVersion.contentHash,
    harnessVersion: harnessVersion.version,
    nodeCount: compiled.plan.stats.nodeCount,
    edgeCount: compiled.plan.stats.edgeCount,
    nodeTypes: [...new Set(compiled.plan.nodes.map((node) => node.type))],
    ...modelParts(providerRef),
    limits,
    allowedTools: agentVersion?.capabilities ?? [],
    executionMode: "unknown",
  };

  const run = await runRepository.create({
    harnessId: harness.id,
    harnessVersionId: harnessVersion.id,
    input: body.input,
    agentId: agent.id,
    agentVersion: agentVersion?.version ?? null,
    metadata,
  });

  // Dispatch happens after the row exists. Metadata is patched separately (not
  // via updateStatus) because the inline dispatcher may already have claimed the
  // run: a status write here would race it back to QUEUED.
  const dispatch = await dispatchRun(run.id, harnessVersion.id);
  const pinnedMetadata: RunMetadata = { ...metadata, executionMode: dispatch.mode };
  await runRepository.updateMetadata(run.id, pinnedMetadata);

  serviceLogger.info("run created", {
    runId: run.id,
    agentId: agent.id,
    harnessId: harness.id,
    harnessVersionId: harnessVersion.id,
    mode: dispatch.mode,
  });

  return { run: { ...run, metadata: pinnedMetadata }, dispatch };
}

/**
 * Lists runs the user may see.
 *
 * Ownership is enforced by scoping the query to the user's workspaces →
 * projects → harnesses/agents, so a foreign harnessId or agentId narrows the
 * result to nothing instead of leaking rows.
 */
export async function listRuns(user: AuthUser, query: ListRunsQuery): Promise<RunListPage> {
  const workspace = await workspaceRepository.findFirstForUser(user.id);
  if (workspace === null) {
    return { runs: [], total: 0, limit: query.limit ?? 20, offset: query.offset ?? 0 };
  }
  const projects = await projectRepository.listByWorkspace(workspace.id);
  const projectIds = projects.map((project) => project.id);

  // An explicit projectId must be one of the user's own projects.
  if (query.projectId !== undefined && !projectIds.includes(query.projectId)) {
    throw new NotFoundError("Project not found");
  }
  const scopedProjectIds = query.projectId !== undefined ? [query.projectId] : projectIds;

  const [harnessIds, agentIds] = await Promise.all([
    runRepository.harnessIdsForProjects(scopedProjectIds),
    runRepository.agentIdsForProjects(scopedProjectIds),
  ]);

  const page = await runRepository.list({
    harnessIds,
    agentIds,
    ...(query.harnessId !== undefined ? { harnessId: query.harnessId } : {}),
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.status !== undefined && query.status.length > 0 ? { status: query.status } : {}),
    ...(query.since !== undefined ? { since: new Date(query.since) } : {}),
    ...(query.until !== undefined ? { until: new Date(query.until) } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  });
  return page;
}

/** Resolves a run and asserts the caller can see its harness. */
async function requireRun(user: AuthUser, runId: string): Promise<Run> {
  const run = await runRepository.findById(runId);
  if (run === null) {
    throw new RunNotFoundError(runId);
  }
  await assertHarnessAccess(user.id, run.harnessId);
  return run;
}

export async function getRunDetail(user: AuthUser, runId: string): Promise<RunDetail> {
  const run = await requireRun(user, runId);
  const [withSteps, events, harnessVersion] = await Promise.all([
    runRepository.findByIdWithSteps(runId),
    runRepository.listEvents(runId),
    harnessRepository.findVersionById(run.harnessVersionId),
  ]);
  if (withSteps === null) {
    throw new RunNotFoundError(runId);
  }

  const harness = await harnessRepository.findById(run.harnessId);
  const agent =
    run.agentId === null ? null : await agentName(run.agentId);

  return {
    run: withSteps,
    steps: withSteps.steps,
    events,
    usage: withSteps.usage,
    usageTotal: usageTotals(withSteps.usage, run.tokenUsage),
    harness: {
      id: run.harnessId,
      name: harness?.name ?? "Harness",
      slug: harness?.slug ?? run.harnessId,
    },
    harnessVersionLabel: harnessVersion?.version ?? run.metadata?.harnessVersion ?? null,
    agent,
    live: !isTerminalRunStatus(run.status),
  };
}

async function agentName(agentId: string): Promise<{ id: string; name: string } | null> {
  const { getPrisma } = await import("@/lib/db/prisma");
  const row = await getPrisma().agent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true },
  });
  return row;
}

function usageTotals(
  usage: RuntimeUsageRecord[],
  tokenUsage: Run["tokenUsage"],
): RunDetail["usageTotal"] {
  const calls = usage.reduce((sum, entry) => sum + entry.calls, 0);
  const promptTokens =
    usage.length > 0
      ? usage.reduce((sum, entry) => sum + entry.promptTokens, 0)
      : (tokenUsage?.promptTokens ?? 0);
  const completionTokens =
    usage.length > 0
      ? usage.reduce((sum, entry) => sum + entry.completionTokens, 0)
      : (tokenUsage?.completionTokens ?? 0);
  const totalTokens =
    usage.length > 0
      ? usage.reduce((sum, entry) => sum + entry.totalTokens, 0)
      : (tokenUsage?.totalTokens ?? 0);
  const unknownCost = usage.some((entry) => entry.costUsd === null);
  const costUsd = usage.reduce(
    (sum, entry) => (entry.costUsd === null ? sum : sum + entry.costUsd),
    0,
  );
  return { calls, promptTokens, completionTokens, totalTokens, costUsd, unknownCost };
}

/**
 * Requests cancellation.
 *
 * The database flag is the durable record; the cancellation channel (Redis /
 * in-process) is what a running executor polls. A run that has not started yet
 * is cancelled outright — its queued job becomes a no-op.
 */
export async function cancelRun(user: AuthUser, runId: string): Promise<Run> {
  const run = await requireRun(user, runId);
  if (isTerminalRunStatus(run.status)) {
    throw new RunConflictError(`Run is already ${run.status.toLowerCase()} and cannot be cancelled`);
  }

  await runRepository.requestCancellation(runId);
  await requestRunCancellation(runId, `cancelled by user ${user.id}`);

  if (run.status === "QUEUED") {
    await runRepository.updateStatus(runId, {
      status: "CANCELLED",
      completedAt: new Date(),
      error: { code: "CANCELLED", message: "Cancelled before execution started", retryable: false },
    });
    await clearRunCancellation(runId);
  }

  serviceLogger.info("run cancellation requested", { runId, userId: user.id });
  const updated = await runRepository.findById(runId);
  return updated ?? run;
}

/**
 * Retries a run by creating a NEW one with the same pins and input.
 * The original row is never touched — history stays immutable.
 */
export async function retryRun(user: AuthUser, runId: string): Promise<CreatedRun> {
  const original = await requireRun(user, runId);
  if (original.agentId === null) {
    throw new RunConflictError("This run has no agent to retry with");
  }

  const harnessVersion = await harnessRepository.findVersionById(original.harnessVersionId);
  const compiled = harnessVersion === null ? null : compileHarness(harnessVersion.definition);
  if (harnessVersion === null || compiled === null || !compiled.ok) {
    throw new RunConflictError(
      "The harness version this run used is no longer executable — publish a new version first",
    );
  }

  const metadata: RunMetadata = {
    ...(original.metadata ?? {
      engineVersion: RUNTIME_ENGINE_VERSION,
      harnessContentHash: harnessVersion.contentHash,
      harnessVersion: harnessVersion.version,
      nodeCount: compiled.plan.stats.nodeCount,
      edgeCount: compiled.plan.stats.edgeCount,
      nodeTypes: [...new Set(compiled.plan.nodes.map((node) => node.type))],
      model: null,
      provider: null,
      limits: DEFAULT_RUNTIME_LIMITS,
      allowedTools: [],
      executionMode: "unknown",
    }),
    engineVersion: RUNTIME_ENGINE_VERSION,
    retryOfRunId: original.id,
  };

  const run = await runRepository.create({
    harnessId: original.harnessId,
    harnessVersionId: original.harnessVersionId,
    input: original.input,
    agentId: original.agentId,
    agentVersion: original.agentVersion,
    metadata,
    attempt: original.attempt + 1,
    retryOfRunId: original.id,
  });

  const dispatch = await dispatchRun(run.id, harnessVersion.id);
  const pinnedMetadata: RunMetadata = { ...metadata, executionMode: dispatch.mode };
  await runRepository.updateMetadata(run.id, pinnedMetadata);

  serviceLogger.info("run retried", {
    runId: run.id,
    retryOfRunId: original.id,
    attempt: run.attempt,
    mode: dispatch.mode,
  });
  return { run: { ...run, metadata: pinnedMetadata }, dispatch };
}

export interface HarnessRunPreview extends ExecutionPreview {
  harnessId: string;
  /** Version that a Run click would execute (null when the harness has none). */
  harnessVersionId: string | null;
  harnessVersionLabel: number | null;
  source: "version" | "draft";
  agentId: string | null;
  /** Only a valid, agent-attached, *published* harness can be run. */
  canRun: boolean;
  /** Explains why running is unavailable, for the dialog. */
  blockedReason: string | null;
}

/**
 * Execution preview for the builder's Run dialog: compiles a published version
 * (or the current draft) and reports checks, warnings and estimated execution.
 */
export async function previewHarnessRun(
  user: AuthUser,
  harnessId: string,
  harnessVersionId?: string,
): Promise<HarnessRunPreview> {
  const harness = await assertHarnessAccess(user.id, harnessId);

  let definition: unknown;
  let resolvedVersionId: string | null = null;
  let versionLabel: number | null = null;
  let source: "version" | "draft" = "draft";

  if (harnessVersionId !== undefined) {
    const version = await harnessRepository.findVersionById(harnessVersionId);
    if (version === null || version.harnessId !== harness.id) {
      throw new NotFoundError("Harness version not found");
    }
    definition = version.definition;
    resolvedVersionId = version.id;
    versionLabel = version.version;
    source = "version";
  } else {
    const latest = await harnessRepository.findLatestVersion(harness.id);
    definition = latest?.definition ?? (await harnessRepository.findDraft(harness.id))?.definition;
    resolvedVersionId = latest?.id ?? null;
    versionLabel = latest?.version ?? null;
    source = latest === null ? "draft" : "version";
  }

  if (definition === undefined || definition === null) {
    throw new HarnessConflictError("This harness has no graph to run yet");
  }

  const preview = previewHarnessCompilation(definition);
  const blockedReason = !preview.ok
    ? "Fix the validation issues below before running"
    : harness.agentId === null
      ? "Attach this harness to an agent first"
      : resolvedVersionId === null
        ? "Publish a version to run — drafts are not executable"
        : null;

  return {
    ...preview,
    harnessId: harness.id,
    harnessVersionId: resolvedVersionId,
    harnessVersionLabel: versionLabel,
    source,
    agentId: harness.agentId,
    canRun: blockedReason === null,
    blockedReason,
  };
}

/** Runs recently finished for an agent, used by the agent Runs tab. */
export async function listRunsForAgent(
  user: AuthUser,
  agentId: string,
  limit = 20,
): Promise<RunListItem[]> {
  await assertAgentAccess(user.id, agentId);
  const page = await runRepository.list({ agentId, limit });
  return page.runs;
}

export async function listRunsForHarness(
  user: AuthUser,
  harnessId: string,
  limit = 20,
): Promise<RunListItem[]> {
  await assertHarnessAccess(user.id, harnessId);
  const page = await runRepository.list({ harnessId, limit });
  return page.runs;
}

export type { CreateRunInput };
