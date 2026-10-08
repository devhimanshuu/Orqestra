/**
 * Evaluation domain concepts (Phase 4).
 *
 * Phase 0 fixes the vocabulary so later phases add tables, not new mental
 * models:
 *
 *   Dataset     — a versioned collection of inputs (+ optional expected outputs)
 *   Evaluator   — a scoring procedure (deterministic check or LLM-as-judge)
 *   Evaluation  — the result of scoring one run against a dataset/evaluator
 *
 * Nothing here touches the database yet; the shapes below are the contract
 * that Phase 4 will persist.
 */

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Rows are stored as JSON until the dataset editor lands. */
  rows: DatasetRow[];
  contentHash: string;
  createdAt: Date;
}

export interface DatasetRow {
  id: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
}

export const EVALUATOR_KINDS = [
  "exact_match",
  "contains",
  "regex",
  "json_schema",
  "llm_judge",
] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export interface Evaluator {
  id: string;
  projectId: string;
  name: string;
  kind: EvaluatorKind;
  description: string | null;
  /** Kind-specific configuration (e.g. judge model, threshold). */
  config: Record<string, unknown>;
  version: number;
  createdAt: Date;
}

export interface EvaluationScore {
  metric: string;
  value: number;
  passed: boolean;
  /** Evaluator rationale — essential for LLM judges. */
  rationale: string | null;
}

export interface Evaluation {
  id: string;
  runId: string;
  evaluatorId: string;
  datasetId: string | null;
  scores: EvaluationScore[];
  createdAt: Date;
}
