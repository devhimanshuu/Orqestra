import type { HarnessDefinition } from "./harness.schema";
import type { HarnessValidationIssue } from "./harness.validation";

/**
 * Domain concepts — deliberately independent from Prisma models.
 *
 * Harness         : mutable shell (identity, ownership, current version pointer)
 * HarnessDraft    : the editable working copy (autosaved, never a version)
 * HarnessVersion  : immutable snapshot of a validated HarnessDefinition
 *                   + content hash + release notes. Runs pin a HarnessVersion.
 *
 * Drafts are mutable; versions are not. `publishHarnessVersion` is the only
 * way a draft becomes a version.
 */

export const HARNESS_STATUSES = ["DRAFT", "VALID", "INVALID", "ARCHIVED"] as const;
export type HarnessStatus = (typeof HARNESS_STATUSES)[number];

export interface Harness {
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  status: HarnessStatus;
  nodeCount: number;
  edgeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** List projection used by project/agent overviews. */
export interface HarnessSummary {
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  status: HarnessStatus;
  currentVersion: number;
  nodeCount: number;
  edgeCount: number;
  updatedAt: Date;
}

export interface HarnessDraft {
  harnessId: string;
  /** Stored as-is: a draft may be invalid while it is being edited. */
  definition: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface HarnessVersion {
  id: string;
  harnessId: string;
  version: number;
  name: string;
  definition: HarnessDefinition;
  /** SHA-256 of the canonical serialization — reproducibility anchor. */
  contentHash: string;
  entryNode: string;
  status: string;
  releaseNotes: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface HarnessDetail {
  harness: Harness;
  /** Present once the harness has been opened/edited; falls back to latest version. */
  draft: HarnessDraft | null;
  /**
   * What the builder should load: the draft if it exists, else the latest
   * version. Raw JSON — it may be mid-edit and not yet a valid definition.
   */
  currentDefinition: unknown;
  versions: HarnessVersion[];
  validation: { ok: boolean; issues: HarnessValidationIssue[] };
  runCount: number;
  agent: { id: string; name: string } | null;
}

export interface CreateHarnessInput {
  name: string;
  description?: string;
  slug?: string;
  /** Optional graph to start from (import/duplicate); otherwise a default start→end graph. */
  definition?: unknown;
}

export interface SaveDraftInput {
  definition: unknown;
}

export interface PublishVersionInput {
  /** Defaults to the current draft. */
  definition?: unknown;
  releaseNotes?: string;
}

export interface PublishVersionResult {
  harnessVersion: HarnessVersion;
  /** false when an identical version already existed (content hash match). */
  created: boolean;
}

export interface DuplicateHarnessInput {
  name?: string;
  /** Version to copy; defaults to the draft (or latest version). */
  sourceVersionId?: string;
}

export interface ExportResult {
  fileName: string;
  document: HarnessExportDocument;
}

/** Portable export envelope — importable into any project/agent. */
export interface HarnessExportDocument {
  format: "orqestra.harness";
  exportedAt: string;
  harness: {
    name: string;
    description: string | null;
    slug: string;
  };
  version: number | null;
  releaseNotes?: string | null;
  definition: HarnessDefinition;
}

/** Domain error carrying structured validation issues. */
export class HarnessValidationError extends Error {
  public readonly issues: HarnessValidationIssue[];

  constructor(issues: HarnessValidationIssue[]) {
    super(
      `Harness validation failed:\n${issues
        .map((issue) => `  [${issue.code}] ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "HarnessValidationError";
    this.issues = issues;
  }
}

export class HarnessNotFoundError extends Error {
  constructor(harnessId: string) {
    super(`Harness "${harnessId}" not found`);
    this.name = "HarnessNotFoundError";
  }
}

export class HarnessConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConflictError";
  }
}
