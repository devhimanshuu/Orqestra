import type { AuthUser } from "@/lib/auth/provider";
import { ConflictError, NotFoundError, ValidationFailedError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { slugifyOrDefault } from "@/lib/slugify";
import { assertAgentAccess, assertHarnessAccess } from "@/modules/access/access.service";
import { harnessDraftDocumentSchema, type HarnessDefinition } from "./harness.schema";
import { harnessRepository } from "./harness.repository";
import { hashHarnessDefinition } from "./harness.serialize";
import { validateHarnessDefinition } from "./harness.validation";
import {
  createHarnessSchema,
  duplicateHarnessSchema,
  importHarnessSchema,
  publishVersionSchema,
  saveDraftSchema,
  updateHarnessSchema,
} from "./harness.inputs";
import type {
  CreateHarnessInput,
  DuplicateHarnessInput,
  ExportResult,
  Harness,
  HarnessDetail,
  HarnessDraft,
  HarnessExportDocument,
  HarnessStatus,
  HarnessVersion,
  PublishVersionInput,
  PublishVersionResult,
} from "./harness.types";
import { HarnessConflictError, HarnessNotFoundError, HarnessValidationError } from "./harness.types";
import type { HarnessValidationIssue, HarnessValidationResult } from "./harness.validation";

/**
 * Harness service — the only entry point for harness mutations.
 *
 * Versioning strategy:
 *  - `HarnessDraft` is the mutable working copy (autosaved by the builder).
 *  - `HarnessVersion` rows are immutable: validated → canonicalized → hashed →
 *    written once, never updated. Publishing an identical definition is a no-op
 *    that returns the existing version (content-hash dedup).
 *  - Runs pin a HarnessVersion id, so every execution stays reproducible.
 */

/** A brand-new harness starts as a valid Start → End graph. */
export function defaultHarnessDefinition(name: string): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: slugifyOrDefault(name, "harness"),
    version: 1,
    name,
    nodes: [
      { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 140 } },
      { id: "end", type: "end", label: "End", config: {}, position: { x: 320, y: 140 } },
    ],
    edges: [{ id: "e-start-end", source: "start", target: "end" }],
    entryNode: "start",
    exitNodes: ["end"],
  };
}

function assertValidOrThrow(input: unknown): HarnessDefinition {
  const result = validateHarnessDefinition(input);
  if (!result.ok) {
    throw new HarnessValidationError(result.issues);
  }
  return result.definition;
}

function countsOf(definition: HarnessDefinition): { nodeCount: number; edgeCount: number } {
  return { nodeCount: definition.nodes.length, edgeCount: definition.edges.length };
}

/** Shape-checks a draft document (looser than a full definition) before storing it. */
function parseDraftDocument(input: unknown): { nodes: number; edges: number; raw: unknown } {
  const parsed = harnessDraftDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationFailedError(
      "The harness draft is malformed",
      parsed.error.issues.map((issue) => ({
        code: "INVALID_SCHEMA",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    );
  }
  return { nodes: parsed.data.nodes.length, edges: parsed.data.edges.length, raw: parsed.data };
}

async function uniqueSlugFor(projectId: string, base: string): Promise<string> {
  let candidate = slugifyOrDefault(base, "harness");
  let attempt = 2;
  while (await harnessRepository.slugExists(projectId, candidate)) {
    candidate = `${slugifyOrDefault(base, "harness")}-${attempt}`;
    attempt += 1;
  }
  return candidate;
}

export async function createHarness(
  user: AuthUser,
  agentId: string,
  input: unknown,
): Promise<{ harness: Harness; harnessVersion: HarnessVersion }> {
  const parsed = createHarnessSchema.parse(input);
  const agent = await assertAgentAccess(user.id, agentId);

  const definition: HarnessDefinition =
    parsed.definition === undefined
      ? defaultHarnessDefinition(parsed.name)
      : { ...assertValidOrThrow(parsed.definition), name: parsed.name };

  const slug = await uniqueSlugFor(agent.projectId, parsed.slug ?? parsed.name);
  const stamped: HarnessDefinition = { ...definition, id: slug, version: 1 };
  const created = await harnessRepository.createWithVersion({
    projectId: agent.projectId,
    agentId: agent.id,
    name: parsed.name,
    slug,
    description: parsed.description,
    definition: stamped,
    contentHash: hashHarnessDefinition(stamped),
    entryNode: stamped.entryNode,
    ...countsOf(stamped),
    status: "VALID",
    createdBy: user.id,
  });

  // The draft starts as a copy of v1 so the builder can autosave immediately.
  await harnessRepository.upsertDraft({
    harnessId: created.harness.id,
    definition: stamped,
    status: "VALID",
    ...countsOf(stamped),
    updatedBy: user.id,
  });

  logger.info("harness created", {
    harnessId: created.harness.id,
    agentId: agent.id,
    userId: user.id,
  });
  return created;
}

export async function getHarnessDetail(user: AuthUser, harnessId: string): Promise<HarnessDetail> {
  const harness = await assertHarnessAccess(user.id, harnessId);
  const [draft, versions, runCount, agent] = await Promise.all([
    harnessRepository.findDraft(harness.id),
    harnessRepository.listVersions(harness.id),
    harnessRepository.countRuns(harness.id),
    harness.agentId !== null
      ? harnessRepository.findAgentSummary(harness.agentId)
      : Promise.resolve(null),
  ]);

  // The builder loads the *raw* graph (it may be mid-edit and invalid) and
  // decorates it with the validation result.
  const currentDefinition = draft?.definition ?? versions[0]?.definition ?? null;
  const validation =
    currentDefinition === null
      ? { ok: false as const, issues: [] as HarnessValidationIssue[] }
      : validateHarnessDefinition(currentDefinition);

  return {
    harness,
    draft,
    currentDefinition,
    versions,
    validation: { ok: validation.ok, issues: validation.ok ? [] : validation.issues },
    runCount,
    agent,
  };
}

/** Autosave: stores the draft, revalidates server-side, and updates harness status. */
export async function saveHarnessDraft(
  user: AuthUser,
  harnessId: string,
  input: unknown,
): Promise<{ draft: HarnessDraft; validation: HarnessValidationResult; status: HarnessStatus }> {
  const parsed = saveDraftSchema.parse(input);
  const harness = await assertHarnessAccess(user.id, harnessId);

  const { nodes, edges, raw } = parseDraftDocument(parsed.definition);
  const validation = validateHarnessDefinition(raw);
  // An archived harness stays archived even if its draft is valid.
  const status: HarnessStatus =
    harness.status === "ARCHIVED" ? "ARCHIVED" : validation.ok ? "VALID" : "INVALID";

  const draft = await harnessRepository.upsertDraft({
    harnessId: harness.id,
    definition: raw,
    status,
    nodeCount: nodes,
    edgeCount: edges,
    updatedBy: user.id,
  });

  logger.debug("harness draft saved", { harnessId: harness.id, status, userId: user.id });
  return { draft, validation, status };
}

/** Validates a definition without persisting anything (builder "Validate" action). */
export async function validateHarnessForUser(
  user: AuthUser,
  harnessId: string,
  input: unknown,
): Promise<HarnessValidationResult> {
  await assertHarnessAccess(user.id, harnessId);
  const definition = (input as { definition?: unknown }).definition;
  return validateHarnessDefinition(definition);
}

/** Publishes an immutable version from an explicit definition or the current draft. */
export async function publishHarnessVersion(
  user: AuthUser,
  harnessId: string,
  input: unknown,
): Promise<PublishVersionResult> {
  const parsed = publishVersionSchema.parse(input);
  const harness = await assertHarnessAccess(user.id, harnessId);

  const source = parsed.definition ?? (await harnessRepository.findDraft(harness.id))?.definition;
  if (source === undefined || source === null) {
    throw new HarnessConflictError("There is nothing to publish yet — open the builder first");
  }

  const definition = assertValidOrThrow(source);
  const latest = await harnessRepository.findLatestVersion(harness.id);
  const nextVersion = (latest?.version ?? 0) + 1;

  const stamped: HarnessDefinition = { ...definition, id: harness.slug, version: nextVersion };
  const contentHash = hashHarnessDefinition(stamped);

  if (latest !== null && latest.contentHash === contentHash) {
    logger.info("harness publish skipped (identical content)", {
      harnessId: harness.id,
      version: latest.version,
    });
    return { harnessVersion: latest, created: false };
  }

  const harnessVersion = await harnessRepository.createNextVersion({
    harnessId: harness.id,
    version: nextVersion,
    name: harness.name,
    definition: stamped,
    contentHash,
    entryNode: stamped.entryNode,
    ...countsOf(stamped),
    releaseNotes: parsed.releaseNotes ?? null,
    createdBy: user.id,
  });

  logger.info("harness version published", {
    harnessId: harness.id,
    version: nextVersion,
    contentHash,
    userId: user.id,
  });
  return { harnessVersion, created: true };
}

export async function listHarnessVersions(
  user: AuthUser,
  harnessId: string,
): Promise<HarnessVersion[]> {
  const harness = await assertHarnessAccess(user.id, harnessId);
  return harnessRepository.listVersions(harness.id);
}

export async function updateHarness(
  user: AuthUser,
  harnessId: string,
  input: unknown,
): Promise<Harness> {
  const parsed = updateHarnessSchema.parse(input);
  const harness = await assertHarnessAccess(user.id, harnessId);

  let status: HarnessStatus | undefined;
  if (parsed.status === "ARCHIVED") {
    status = "ARCHIVED";
  } else if (parsed.status === "DRAFT") {
    const draft = await harnessRepository.findDraft(harness.id);
    status = draft === null ? "DRAFT" : validateHarnessDefinition(draft.definition).ok ? "VALID" : "INVALID";
  }

  const updated = await harnessRepository.updateHarness(harness.id, {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  logger.info("harness updated", { harnessId: harness.id, userId: user.id });
  return updated;
}

/** Duplicates a harness (draft or a specific version) into a new harness at v1. */
export async function duplicateHarness(
  user: AuthUser,
  harnessId: string,
  input: unknown,
): Promise<{ harness: Harness; harnessVersion: HarnessVersion }> {
  const parsed = duplicateHarnessSchema.parse(input);
  const source = await assertHarnessAccess(user.id, harnessId);
  if (source.agentId === null) {
    throw new HarnessConflictError("Harness is not attached to an agent and cannot be duplicated");
  }

  const sourceDefinition =
    parsed.sourceVersionId !== undefined
      ? (await harnessRepository.findVersionById(parsed.sourceVersionId))?.definition
      : ((await harnessRepository.findDraft(source.id))?.definition ??
        (await harnessRepository.findLatestVersion(source.id))?.definition);

  if (sourceDefinition === undefined || sourceDefinition === null) {
    throw new HarnessConflictError("Nothing to duplicate — the harness has no graph yet");
  }

  const name = parsed.name ?? `${source.name} — Experimental`;
  const definition = assertValidOrThrow(sourceDefinition);
  const slug = await uniqueSlugFor(source.projectId, name);
  const stamped: HarnessDefinition = { ...definition, id: slug, version: 1 };

  const created = await harnessRepository.createWithVersion({
    projectId: source.projectId,
    agentId: source.agentId,
    name,
    slug,
    description: `Duplicated from ${source.name} v${source.currentVersion}`,
    definition: stamped,
    contentHash: hashHarnessDefinition(stamped),
    entryNode: stamped.entryNode,
    ...countsOf(stamped),
    status: "VALID",
    createdBy: user.id,
  });

  await harnessRepository.upsertDraft({
    harnessId: created.harness.id,
    definition: stamped,
    status: "VALID",
    ...countsOf(stamped),
    updatedBy: user.id,
  });

  logger.info("harness duplicated", {
    sourceHarnessId: source.id,
    harnessId: created.harness.id,
    userId: user.id,
  });
  return created;
}

export async function getHarnessVersion(
  user: AuthUser,
  harnessId: string,
  versionId: string,
): Promise<HarnessVersion> {
  await assertHarnessAccess(user.id, harnessId);
  const version = await harnessRepository.findVersionById(versionId);
  if (version === null || version.harnessId !== harnessId) {
    throw new NotFoundError("Harness version not found");
  }
  return version;
}

// ------------------------------------------------------------------------------
// Portability: export / import
// ------------------------------------------------------------------------------

/**
 * Exports a harness as a portable JSON document.
 * A specific published version can be requested; otherwise the latest version
 * is exported, falling back to the draft for harnesses that were never published.
 */
export async function exportHarness(
  user: AuthUser,
  harnessId: string,
  options: { version?: number } = {},
): Promise<ExportResult> {
  const harness = await assertHarnessAccess(user.id, harnessId);

  const version =
    options.version !== undefined
      ? await harnessRepository.findVersionByNumber(harness.id, options.version)
      : await harnessRepository.findLatestVersion(harness.id);

  if (options.version !== undefined && version === null) {
    throw new NotFoundError(`Version v${options.version} does not exist`);
  }

  const draft = version === null ? await harnessRepository.findDraft(harness.id) : null;
  const definition = version?.definition ?? (draft?.definition as HarnessDefinition | undefined);
  if (definition === undefined || definition === null) {
    throw new HarnessConflictError("Nothing to export yet — the harness has no graph");
  }

  const document: HarnessExportDocument = {
    format: "orqestra.harness",
    exportedAt: new Date().toISOString(),
    harness: { name: harness.name, description: harness.description, slug: harness.slug },
    version: version?.version ?? null,
    releaseNotes: version?.releaseNotes ?? null,
    definition: assertValidOrThrow(definition),
  };

  return {
    fileName: `${harness.slug}-${version !== null ? `v${version.version}` : "draft"}.json`,
    document,
  };
}

/**
 * Imports an exported document as a new harness (v1) under an agent.
 * The definition is fully revalidated; imports cannot introduce invalid graphs.
 */
export async function importHarness(
  user: AuthUser,
  input: unknown,
): Promise<{ harness: Harness; harnessVersion: HarnessVersion }> {
  const parsed = importHarnessSchema.parse(input);
  const agent = await assertAgentAccess(user.id, parsed.agentId);
  const document = parsed.document;

  const definition = assertValidOrThrow(document.definition);
  const slug = await uniqueSlugFor(agent.projectId, document.harness.slug ?? document.harness.name);
  const stamped: HarnessDefinition = { ...definition, id: slug, version: 1 };

  const created = await harnessRepository.createWithVersion({
    projectId: agent.projectId,
    agentId: agent.id,
    name: document.harness.name,
    slug,
    description: document.harness.description ?? undefined,
    definition: stamped,
    contentHash: hashHarnessDefinition(stamped),
    entryNode: stamped.entryNode,
    ...countsOf(stamped),
    status: "VALID",
    createdBy: user.id,
  });

  await harnessRepository.upsertDraft({
    harnessId: created.harness.id,
    definition: stamped,
    status: "VALID",
    ...countsOf(stamped),
    updatedBy: user.id,
  });

  logger.info("harness imported", {
    harnessId: created.harness.id,
    agentId: agent.id,
    sourceVersion: document.version ?? null,
    userId: user.id,
  });
  return created;
}

export { HarnessValidationError };
export type { CreateHarnessInput, DuplicateHarnessInput, PublishVersionInput };
