import type { EvaluatorKind } from "./evaluation.types";

/**
 * Evaluator *configuration* (distinct from the evaluator implementation).
 *
 *   Evaluator          mutable shell (name, enabled, currentVersion)
 *    └── EvaluatorVersion  immutable revision (kind + validated config + weight)
 *
 * A batch pins versions, so editing an evaluator's rubric never changes the
 * meaning of a completed evaluation.
 */

export interface EvaluatorConfigRecord {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: EvaluatorKind;
  enabled: boolean;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluatorVersionRecord {
  id: string;
  evaluatorId: string;
  version: number;
  name: string;
  kind: EvaluatorKind;
  description: string | null;
  config: Record<string, unknown>;
  weight: number;
  contentHash: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface EvaluatorWithVersion extends EvaluatorConfigRecord {
  current: EvaluatorVersionRecord;
  versionCount: number;
}

export class EvaluatorNotFoundError extends Error {
  constructor(evaluatorId: string) {
    super(`Evaluator "${evaluatorId}" not found`);
    this.name = "EvaluatorNotFoundError";
  }
}

export class EvaluatorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorConflictError";
  }
}

export class EvaluatorInvalidError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "EvaluatorInvalidError";
    this.issues = issues;
  }
}
