import type { AuthUser } from "@/lib/auth/provider";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { slugifyOrDefault } from "@/lib/slugify";
import { assertDatasetAccess, assertProjectAccess } from "@/modules/access/access.service";
import { listProjects } from "@/modules/projects/project.service";
import { datasetRepository } from "./dataset.repository";
import type {
  Dataset,
  DatasetCase,
  DatasetCaseSnapshot,
  DatasetSummary,
  DatasetVersion,
  DatasetWithCases,
} from "./dataset.types";
import { DatasetConflictError, DatasetInUseError } from "./dataset.types";
import {
  buildDatasetExport,
  parseDatasetImport,
  type DatasetCaseRecord,
  type DatasetExportDocument,
} from "./dataset.schema";
import { hashJson } from "./hashing";
import type {
  CreateDatasetBody,
  DatasetCaseBody,
  DatasetCaseUpdateBody,
  ImportDatasetBody,
  ListDatasetsQuery,
  PublishDatasetVersionBody,
  UpdateDatasetBody,
} from "./dataset.inputs";

/**
 * Dataset service.
 *
 * Rules that matter:
 *  - every read and write resolves ownership server-side (workspace → project →
 *    dataset); ids from the client never grant access;
 *  - publishing a version writes an immutable snapshot; publishing an unchanged
 *    working set returns the existing version instead of creating a duplicate
 *    (content hash equality), so "version 4" always means a different corpus
 *    than "version 3";
 *  - deleting a dataset that evaluation batches pin is refused: those batches
 *    would lose their meaning. The batches can be deleted first.
 */

const serviceLogger = logger.child({ module: "evaluation.datasets" });

/** Project ids the user may touch, resolved from workspace membership. */
async function scopedProjectIds(user: AuthUser): Promise<string[]> {
  const projects = await listProjects(user);
  return projects.map((project) => project.id);
}

function toSnapshot(entry: DatasetCase): DatasetCaseSnapshot {
  return {
    caseKey: entry.caseKey,
    name: entry.name,
    input: entry.input,
    expectedOutput: entry.expectedOutput,
    metadata: entry.metadata,
    tags: entry.tags,
  };
}

export async function listDatasets(
  user: AuthUser,
  query: ListDatasetsQuery,
): Promise<{ datasets: DatasetSummary[]; total: number }> {
  const projectIds = await scopedProjectIds(user);
  if (query.projectId !== undefined) {
    const project = await assertProjectAccess(user.id, query.projectId);
    const summaries = await datasetRepository.listByProject(project.id);
    return { datasets: filterByQuery(summaries, query.q), total: summaries.length };
  }

  const all: DatasetSummary[] = [];
  for (const projectId of projectIds) {
    const rows = await datasetRepository.listByProject(projectId);
    all.push(...rows);
  }
  all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const filtered = filterByQuery(all, query.q);
  return { datasets: filtered, total: filtered.length };
}

function filterByQuery(rows: DatasetSummary[], q: string | undefined): DatasetSummary[] {
  if (q === undefined || q.trim() === "") {
    return rows;
  }
  const needle = q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle),
  );
}

export async function getDatasetDetail(user: AuthUser, datasetId: string): Promise<DatasetWithCases> {
  const dataset = await assertDatasetAccess(user.id, datasetId);
  const detail = await datasetRepository.findWithCases(dataset.id);
  if (detail === null) {
    throw new NotFoundError("Dataset not found");
  }
  return { ...detail.dataset, cases: detail.cases, versions: detail.versions };
}

export async function createDataset(user: AuthUser, input: CreateDatasetBody): Promise<{ dataset: Dataset; version: DatasetVersion }> {
  await assertProjectAccess(user.id, input.projectId);
  const slug = slugifyOrDefault(input.slug ?? input.name, "dataset");
  const existing = await datasetRepository.findBySlug(input.projectId, slug);
  if (existing !== null) {
    throw new ConflictError(`A dataset named "${input.name}" already exists in this project`);
  }

  const cases: DatasetCaseSnapshot[] = (input.cases ?? []).map((entry) => ({
    caseKey: entry.caseKey,
    name: entry.name ?? null,
    input: entry.input,
    expectedOutput: entry.expectedOutput ?? null,
    metadata: entry.metadata ?? null,
    tags: entry.tags ?? [],
  }));

  const dataset = await datasetRepository.create({
    projectId: input.projectId,
    name: input.name.trim(),
    slug,
    description: input.description ?? null,
    cases,
  });

  // Version 1 is the initial snapshot, so a batch can always pin something
  // without the author having to remember to publish first.
  const version = await datasetRepository.publishVersion({
    datasetId: dataset.id,
    version: 1,
    name: "Initial version",
    cases,
    contentHash: hashJson(cases),
    createdBy: user.id,
  });

  serviceLogger.info("dataset created", {
    datasetId: dataset.id,
    projectId: dataset.projectId,
    cases: cases.length,
    userId: user.id,
  });
  return { dataset: { ...dataset, currentVersion: 1 }, version };
}

export async function updateDataset(
  user: AuthUser,
  datasetId: string,
  input: UpdateDatasetBody,
): Promise<Dataset> {
  await assertDatasetAccess(user.id, datasetId);
  return datasetRepository.update(datasetId, {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

export async function deleteDataset(user: AuthUser, datasetId: string): Promise<void> {
  await assertDatasetAccess(user.id, datasetId);
  const [batchCount, experimentCount] = await Promise.all([
    datasetRepository.countBatches(datasetId),
    datasetRepository.countExperiments(datasetId),
  ]);
  // Experiments (Phase 4) pin a dataset version exactly like batches do, so the
  // same guard applies: their results would lose their meaning if the cases
  // disappeared. Covered together so one message explains both blockers.
  if (batchCount > 0 || experimentCount > 0) {
    throw new DatasetInUseError(datasetId, batchCount, experimentCount);
  }
  await datasetRepository.delete(datasetId);
  serviceLogger.info("dataset deleted", { datasetId, userId: user.id });
}

/**
 * Publishes the working set as a new immutable version. Returns the existing
 * version when the corpus is unchanged — a no-op publish is not a new version.
 */
export async function publishDatasetVersion(
  user: AuthUser,
  datasetId: string,
  input: PublishDatasetVersionBody,
): Promise<{ version: DatasetVersion; created: boolean }> {
  const dataset = await assertDatasetAccess(user.id, datasetId);
  const cases = await datasetRepository.listCases(dataset.id);
  if (cases.length === 0) {
    throw new DatasetConflictError("Add at least one test case before publishing a version");
  }

  const snapshots = cases.map(toSnapshot);
  const contentHash = hashJson(snapshots);
  const latest = await datasetRepository.findLatestVersion(dataset.id);
  if (latest !== null && latest.contentHash === contentHash) {
    return { version: latest, created: false };
  }

  const version = await datasetRepository.publishVersion({
    datasetId: dataset.id,
    version: (latest?.version ?? 0) + 1,
    name: input.name ?? `v${(latest?.version ?? 0) + 1}`,
    cases: snapshots,
    contentHash,
    createdBy: user.id,
  });
  serviceLogger.info("dataset version published", {
    datasetId,
    version: version.version,
    cases: snapshots.length,
    userId: user.id,
  });
  return { version, created: true };
}

// --- cases -------------------------------------------------------------------

export async function addDatasetCase(
  user: AuthUser,
  datasetId: string,
  body: DatasetCaseBody,
): Promise<DatasetCase> {
  const dataset = await assertDatasetAccess(user.id, datasetId);
  const existing = await datasetRepository.findCase(dataset.id, body.caseKey);
  if (existing !== null) {
    throw new ConflictError(`A test case with key "${body.caseKey}" already exists`);
  }
  return datasetRepository.addCase(dataset.id, {
    caseKey: body.caseKey,
    name: body.name ?? null,
    input: body.input,
    expectedOutput: body.expectedOutput ?? null,
    metadata: body.metadata ?? null,
    tags: body.tags ?? [],
  });
}

export async function updateDatasetCase(
  user: AuthUser,
  datasetId: string,
  caseKey: string,
  body: DatasetCaseUpdateBody,
): Promise<DatasetCase> {
  const dataset = await assertDatasetAccess(user.id, datasetId);
  const existing = await datasetRepository.findCase(dataset.id, caseKey);
  if (existing === null) {
    throw new NotFoundError(`Test case "${caseKey}" not found`);
  }
  return datasetRepository.updateCase(dataset.id, caseKey, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.input !== undefined ? { input: body.input } : {}),
    ...(body.expectedOutput !== undefined ? { expectedOutput: body.expectedOutput } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
  });
}

export async function removeDatasetCase(
  user: AuthUser,
  datasetId: string,
  caseKey: string,
): Promise<void> {
  const dataset = await assertDatasetAccess(user.id, datasetId);
  const existing = await datasetRepository.findCase(dataset.id, caseKey);
  if (existing === null) {
    throw new NotFoundError(`Test case "${caseKey}" not found`);
  }
  await datasetRepository.removeCase(dataset.id, caseKey);
}

// --- import / export ---------------------------------------------------------

export interface ImportResult {
  dataset: Dataset;
  importedCases: number;
  replaced: boolean;
}

/**
 * Imports a dataset document. The document is validated *before* anything is
 * written, and the whole import is a list of issues on failure — never a
 * partially-applied import.
 */
export async function importDataset(
  user: AuthUser,
  body: ImportDatasetBody,
): Promise<ImportResult> {
  const parsed = parseDatasetImport(body.document);
  if (!parsed.ok) {
    throw new DatasetConflictError(
      `The dataset file is not valid: ${parsed.issues
        .slice(0, 5)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}${parsed.issues.length > 5 ? ` (+${parsed.issues.length - 5} more)` : ""}`,
    );
  }

  const snapshots: DatasetCaseSnapshot[] = parsed.dataset.cases.map((entry) => ({
    caseKey: entry.caseKey,
    name: entry.name ?? null,
    input: entry.input,
    expectedOutput: entry.expectedOutput ?? null,
    metadata: entry.metadata ?? null,
    tags: entry.tags ?? [],
  }));

  if (body.mode === "replace") {
    if (body.datasetId === undefined) {
      throw new DatasetConflictError("Replacing a dataset requires a datasetId");
    }
    const dataset = await assertDatasetAccess(user.id, body.datasetId);
    const existing = await datasetRepository.listCases(dataset.id);
    for (const entry of existing) {
      await datasetRepository.removeCase(dataset.id, entry.caseKey);
    }
    for (const entry of snapshots) {
      await datasetRepository.addCase(dataset.id, entry);
    }
    serviceLogger.info("dataset replaced from import", {
      datasetId: dataset.id,
      cases: snapshots.length,
      userId: user.id,
    });
    return { dataset, importedCases: snapshots.length, replaced: true };
  }

  const projectId = body.projectId;
  await assertProjectAccess(user.id, projectId);

  const name = parsed.dataset.name;
  const slug = slugifyOrDefault(name, "dataset");
  const duplicate = await datasetRepository.findBySlug(projectId, slug);
  if (duplicate !== null) {
    throw new ConflictError(
      `A dataset named "${name}" already exists in this project — rename it in the file, or import into an existing dataset`,
    );
  }

  const created = await createDataset(user, {
    projectId,
    name,
    ...(parsed.dataset.description !== undefined ? { description: parsed.dataset.description } : {}),
    cases: snapshots.map((entry) => ({
      caseKey: entry.caseKey,
      ...(entry.name !== null ? { name: entry.name } : {}),
      input: entry.input,
      ...(entry.expectedOutput !== null ? { expectedOutput: entry.expectedOutput } : {}),
      ...(entry.metadata !== null ? { metadata: entry.metadata } : {}),
      ...(entry.tags.length > 0 ? { tags: entry.tags } : {}),
    })),
  });
  return { dataset: created.dataset, importedCases: snapshots.length, replaced: false };
}

export async function exportDataset(
  user: AuthUser,
  datasetId: string,
  options: { version?: number } = {},
): Promise<DatasetExportDocument> {
  const dataset = await assertDatasetAccess(user.id, datasetId);

  let cases: DatasetCaseRecord[];
  let versionLabel = dataset.currentVersion;

  if (options.version !== undefined) {
    const version = await datasetRepository.findVersionByNumber(dataset.id, options.version);
    if (version === null) {
      throw new NotFoundError(`Dataset version ${options.version} not found`);
    }
    cases = version.cases.map((entry) => ({
      caseKey: entry.caseKey,
      name: entry.name,
      input: entry.input,
      expectedOutput: entry.expectedOutput,
      metadata: entry.metadata,
      tags: entry.tags,
    }));
    versionLabel = version.version;
  } else {
    const workingSet = await datasetRepository.listCases(dataset.id);
    cases = workingSet.map((entry) => ({
      caseKey: entry.caseKey,
      name: entry.name,
      input: entry.input,
      expectedOutput: entry.expectedOutput,
      metadata: entry.metadata,
      tags: entry.tags,
    }));
  }

  return buildDatasetExport({
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    version: versionLabel,
    cases,
    now: new Date(),
  });
}

/** Datasets across the user's projects — used by pickers on the run lab pages. */
export async function listDatasetsForUser(user: AuthUser): Promise<DatasetSummary[]> {
  const result = await listDatasets(user, {});
  return result.datasets;
}
