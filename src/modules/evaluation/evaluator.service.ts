import type { AuthUser } from "@/lib/auth/provider";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { slugifyOrDefault } from "@/lib/slugify";
import { assertEvaluatorAccess, assertProjectAccess } from "@/modules/access/access.service";
import { listProjects } from "@/modules/projects/project.service";
import {
  getEvaluatorDefinition,
  hasEvaluator,
  listEvaluatorKinds,
  validateEvaluatorConfig,
} from "./evaluator.registry";
import type { EvaluatorKindSummary } from "./evaluators/contract";
import { evaluatorRepository } from "./evaluator.repository";
import type { EvaluatorWithVersion } from "./evaluator.types";
import { EvaluatorConflictError, EvaluatorInvalidError } from "./evaluator.types";
import type {
  CreateEvaluatorBody,
  ListEvaluatorsQuery,
  UpdateEvaluatorBody,
} from "./evaluator.inputs";
import { hashJson } from "./hashing";

/**
 * Evaluator configuration service.
 *
 * Two invariants:
 *  - a configuration is validated against its kind's strict schema *before* it
 *    is stored, so an unusable evaluator cannot be created;
 *  - changing the configuration writes a new immutable revision (never an
 *    update in place), so a batch that pinned revision 2 keeps meaning exactly
 *    what it meant when it ran.
 */

const serviceLogger = logger.child({ module: "evaluation.evaluators" });

export function listKinds(): EvaluatorKindSummary[] {
  return listEvaluatorKinds();
}

/** Validates a config without persisting anything (used by the editor's Test action). */
export function validateConfig(kind: string, config: unknown): ReturnType<typeof validateEvaluatorConfig> {
  return validateEvaluatorConfig(kind, config);
}

async function scopedProjectIds(user: AuthUser): Promise<string[]> {
  const projects = await listProjects(user);
  return projects.map((project) => project.id);
}

export async function listEvaluators(
  user: AuthUser,
  query: ListEvaluatorsQuery,
): Promise<EvaluatorWithVersion[]> {
  if (query.projectId !== undefined) {
    await assertProjectAccess(user.id, query.projectId);
    const rows = await evaluatorRepository.listByProject(query.projectId);
    return applyFilters(rows, query);
  }
  const projectIds = await scopedProjectIds(user);
  if (projectIds.length === 0) {
    return [];
  }
  const rows = await evaluatorRepository.listByProjects(projectIds);
  return applyFilters(rows, query);
}

function applyFilters(rows: EvaluatorWithVersion[], query: ListEvaluatorsQuery): EvaluatorWithVersion[] {
  return rows.filter((row) => {
    if (query.kind !== undefined && row.kind !== query.kind) {
      return false;
    }
    if (query.enabledOnly && !row.enabled) {
      return false;
    }
    return true;
  });
}

export async function getEvaluator(user: AuthUser, evaluatorId: string): Promise<EvaluatorWithVersion> {
  const evaluator = await assertEvaluatorAccess(user.id, evaluatorId);
  const [current, versions] = await Promise.all([
    evaluatorRepository.findCurrentVersion(evaluator.id),
    evaluatorRepository.countVersions(evaluator.id),
  ]);
  if (current === null) {
    throw new NotFoundError("Evaluator has no revision");
  }
  return { ...evaluator, current, versionCount: versions };
}

export async function createEvaluator(
  user: AuthUser,
  input: CreateEvaluatorBody,
): Promise<EvaluatorWithVersion> {
  await assertProjectAccess(user.id, input.projectId);
  if (!hasEvaluator(input.kind)) {
    throw new EvaluatorInvalidError(`Unknown evaluator kind "${input.kind}"`, [
      { path: "kind", message: `Unknown evaluator kind "${input.kind}"` },
    ]);
  }

  const definition = getEvaluatorDefinition(input.kind);
  const validation = validateEvaluatorConfig(
    input.kind,
    input.config ?? definition.defaultConfig,
  );
  if (!validation.ok) {
    throw new EvaluatorInvalidError("The evaluator configuration is not valid", validation.issues);
  }

  const slug = slugifyOrDefault(input.slug ?? input.name, "evaluator");
  const existing = await evaluatorRepository.findBySlug(input.projectId, slug);
  if (existing !== null) {
    throw new ConflictError(`An evaluator named "${input.name}" already exists in this project`);
  }

  const config = validation.config as Record<string, unknown>;
  const weight = input.weight ?? 0;
  const created = await evaluatorRepository.createWithVersion({
    projectId: input.projectId,
    name: input.name.trim(),
    slug,
    description: input.description ?? null,
    kind: input.kind,
    config,
    weight,
    contentHash: hashJson({ kind: input.kind, config, weight }),
    createdBy: user.id,
  });

  serviceLogger.info("evaluator created", {
    evaluatorId: created.evaluator.id,
    kind: input.kind,
    userId: user.id,
  });
  return { ...created.evaluator, current: created.version, versionCount: 1 };
}

export async function updateEvaluator(
  user: AuthUser,
  evaluatorId: string,
  input: UpdateEvaluatorBody,
): Promise<EvaluatorWithVersion> {
  const evaluator = await assertEvaluatorAccess(user.id, evaluatorId);
  const current = await evaluatorRepository.findCurrentVersion(evaluator.id);
  if (current === null) {
    throw new NotFoundError("Evaluator has no revision");
  }

  const metadata = await evaluatorRepository.updateMetadata(evaluator.id, {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });

  const wantsNewRevision =
    (input.config !== undefined && hashJson(input.config) !== hashJson(current.config)) ||
    (input.weight !== undefined && input.weight !== current.weight);

  if (!wantsNewRevision) {
    return {
      ...metadata,
      current,
      versionCount: await evaluatorRepository.countVersions(evaluator.id),
    };
  }

  const definition = getEvaluatorDefinition(evaluator.kind);
  const validation = validateEvaluatorConfig(
    evaluator.kind,
    input.config ?? definition.defaultConfig,
  );
  if (!validation.ok) {
    throw new EvaluatorInvalidError("The evaluator configuration is not valid", validation.issues);
  }
  const config = validation.config as Record<string, unknown>;
  const weight = input.weight ?? current.weight;

  const version = await evaluatorRepository.addVersion({
    evaluatorId: evaluator.id,
    version: current.version + 1,
    name: input.name?.trim() ?? current.name,
    kind: evaluator.kind,
    description: input.description ?? current.description,
    config,
    weight,
    contentHash: hashJson({ kind: evaluator.kind, config, weight }),
    createdBy: user.id,
  });

  serviceLogger.info("evaluator revision created", {
    evaluatorId: evaluator.id,
    version: version.version,
    userId: user.id,
  });
  return {
    ...metadata,
    // `metadata` was read before the revision was written, so its
    // `currentVersion` is stale; report the revision that now exists.
    currentVersion: version.version,
    current: version,
    versionCount: await evaluatorRepository.countVersions(evaluator.id),
  };
}

export async function deleteEvaluator(user: AuthUser, evaluatorId: string): Promise<void> {
  await assertEvaluatorAccess(user.id, evaluatorId);
  await evaluatorRepository.delete(evaluatorId);
  serviceLogger.info("evaluator deleted", { evaluatorId, userId: user.id });
}

/**
 * Resolves checkboxes from the batch form ("which evaluators should score
 * this?") into pinned revisions, rejecting ids the caller cannot see and
 * disabled evaluators.
 */
export async function resolveAssignments(
  user: AuthUser,
  selections: Array<{ evaluatorId: string; weight?: number }>,
): Promise<
  Array<{
    evaluatorId: string;
    evaluatorVersion: number;
    kind: string;
    name: string;
    config: Record<string, unknown>;
    weight: number;
  }>
> {
  const resolved: Array<{
    evaluatorId: string;
    evaluatorVersion: number;
    kind: string;
    name: string;
    config: Record<string, unknown>;
    weight: number;
  }> = [];
  for (const selection of selections) {
    const evaluator = await assertEvaluatorAccess(user.id, selection.evaluatorId);
    if (!evaluator.enabled) {
      throw new EvaluatorConflictError(
        `"${evaluator.name}" is disabled — enable it before using it in an evaluation`,
      );
    }
    const version = await evaluatorRepository.findCurrentVersion(evaluator.id);
    if (version === null) {
      throw new EvaluatorConflictError(`"${evaluator.name}" has no revision to run`);
    }
    resolved.push({
      evaluatorId: evaluator.id,
      evaluatorVersion: version.version,
      kind: version.kind,
      name: version.name,
      config: version.config,
      weight: selection.weight ?? version.weight,
    });
  }
  return resolved;
}
