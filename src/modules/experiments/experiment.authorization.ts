/**
 * Selection and promotion authorization.
 *
 * Both actions are decisions a human makes, so the rules here do not "pick a
 * winner" — they state, in testable form, whether a candidate has enough evidence
 * to be selected or promoted, and exactly what is wrong when it does not.
 *
 *   selection  — always allowed on a settled experiment. Warnings are returned so
 *                the UI can show the trade-offs the author is accepting.
 *   promotion  — blocked by a hard-constraint violation, by an experiment that
 *                has not settled, by a candidate with no scored execution, and by
 *                the baseline being promoted as if it were an improvement. It is
 *                *not* blocked by a statistical doubt: that is a warning, because
 *                an author may legitimately promote on a practically meaningful
 *                difference the sample cannot prove. The decision is recorded
 *                with those warnings, so it stays auditable.
 *
 * Keeping this pure means the API, the UI's confirmation dialog and the tests all
 * read the same rule text.
 */

import type { CandidateMetrics } from "./experiment.metrics";
import { evaluateConstraints, type ConstraintEvaluation } from "./experiment.objective";
import type { ExperimentCandidateRecord, ExperimentConstraints, ExperimentStatus } from "./experiment.types";

export interface AuthorizationCheck {
  label: string;
  status: "ok" | "warning" | "blocked";
  detail: string;
}

export interface ExperimentAuthorizationReport {
  /** True when nothing blocks the action. */
  canSelect: boolean;
  canPromote: boolean;
  blockers: string[];
  warnings: string[];
  checks: AuthorizationCheck[];
  constraints: ConstraintEvaluation | null;
}

export interface AuthorizationInput {
  candidate: ExperimentCandidateRecord;
  metrics: CandidateMetrics | null;
  constraints: ExperimentConstraints;
  passThreshold: number | null;
  experimentStatus: ExperimentStatus;
  /** True when no execution is still pending or running. */
  settled: boolean;
  /** Paired cases available against the baseline, when known. */
  pairedCases?: number | null;
  /** The propagation of the paired evidence, when the caller evaluated it. */
  evidenceVerdict?: "supported_improvement" | "supported_regression" | "inconclusive" | "insufficient_sample" | "no_difference" | null;
}

/** Minimum paired sample the statistics module requires before it claims anything. */
const MIN_PAIRED_SAMPLE = 8;

export function verifyExperimentAuthorization(input: AuthorizationInput): ExperimentAuthorizationReport {
  const checks: AuthorizationCheck[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const isBaseline = input.candidate.role === "BASELINE";
  const metrics = input.metrics;

  if (!input.settled) {
    const message = "The experiment still has executions outstanding, so any comparison is provisional.";
    blockers.push(message);
    checks.push({ label: "Execution complete", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Execution complete",
      status: "ok",
      detail: "Every planned execution reached a terminal status.",
    });
  }

  if (metrics === null || metrics.scored === 0) {
    const message = "This candidate produced no scored execution, so there is no evidence to decide on.";
    blockers.push(message);
    checks.push({ label: "Scored evidence", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Scored evidence",
      status: "ok",
      detail: `${metrics.scored} of ${metrics.executions} execution(s) produced an aggregate score (${metrics.caseCount} distinct case(s)).`,
    });
  }

  if (isBaseline) {
    blockers.push("The baseline is the control of this experiment; it cannot be promoted as an improvement.");
    checks.push({
      label: "Candidate role",
      status: "blocked",
      detail: "The baseline is the control — select a candidate that improved on it.",
    });
  } else {
    checks.push({
      label: "Candidate role",
      status: "ok",
      detail: `Pinned to harness version ${input.candidate.harnessVersion} (${input.candidate.harnessSnapshot.harnessName}).`,
    });
  }

  const constraints = metrics === null ? null : evaluateConstraints(metrics, input.constraints);
  if (constraints === null) {
    checks.push({
      label: "Constraints",
      status: "warning",
      detail: "No measured metrics yet, so configured constraints cannot be judged.",
    });
  } else if (constraints.constrained === 0) {
    checks.push({ label: "Constraints", status: "ok", detail: "No constraints were configured for this experiment." });
  } else {
    for (const check of constraints.checks) {
      if (check.satisfied === false) {
        blockers.push(check.explanation);
        warnings.push(check.explanation);
        checks.push({ label: check.label, status: "blocked", detail: check.explanation });
      } else if (check.satisfied === null) {
        warnings.push(check.explanation);
        checks.push({ label: check.label, status: "warning", detail: check.explanation });
      } else {
        checks.push({ label: check.label, status: "ok", detail: check.explanation });
      }
    }
  }

  if (metrics !== null && metrics.incomplete > 0) {
    const detail = `${metrics.incomplete} execution(s) produced an INCOMPLETE aggregate (an evaluator reported no score).`;
    warnings.push(detail);
    checks.push({ label: "Evaluator coverage", status: "warning", detail });
  }
  if (metrics !== null && metrics.evaluatorErrors > 0) {
    const detail = `${metrics.evaluatorErrors} evaluator verdict(s) errored during scoring.`;
    warnings.push(detail);
    checks.push({ label: "Evaluator errors", status: "warning", detail });
  }
  if (metrics !== null && metrics.tokens.unreported > 0) {
    const detail = `${metrics.tokens.unreported} execution(s) reported no token usage, so cost and token figures cover only part of the experiment.`;
    warnings.push(detail);
    checks.push({ label: "Usage reporting", status: "warning", detail });
  }

  // Statistical evidence is a warning, never a blocker: practical significance
  // and statistical proof are different questions, and the author decides.
  const pairedCases = input.pairedCases ?? null;
  if (pairedCases !== null) {
    if (pairedCases < MIN_PAIRED_SAMPLE) {
      const detail = `Only ${pairedCases} paired case(s) could be compared; the documented minimum sample is ${MIN_PAIRED_SAMPLE}.`;
      warnings.push(detail);
      checks.push({ label: "Statistical sample", status: "warning", detail });
    } else {
      checks.push({
        label: "Statistical sample",
        status: "ok",
        detail: `${pairedCases} paired case(s) were available for the paired comparison.`,
      });
    }
  }
  if (input.evidenceVerdict === "supported_regression") {
    const detail = "Paired evidence supports a regression against the baseline.";
    warnings.push(detail);
    checks.push({ label: "Paired evidence", status: "warning", detail });
  } else if (input.evidenceVerdict === "supported_improvement") {
    checks.push({
      label: "Paired evidence",
      status: "ok",
      detail: "Paired evidence supports the improvement.",
    });
  } else if (input.evidenceVerdict === "insufficient_sample" || input.evidenceVerdict === "inconclusive") {
    const detail = "The paired evidence does not establish a difference.";
    warnings.push(detail);
    checks.push({ label: "Paired evidence", status: "warning", detail });
  }

  return {
    canSelect: checks.every((check) => check.status !== "blocked"),
    canPromote: blockers.length === 0,
    blockers,
    warnings,
    checks,
    constraints,
  };
}

/**
 * Promotion-specific gates, kept separate so the promotion path can be unit
 * tested without a database and the service only has to throw the messages.
 */
export function evaluatePromotionGates(input: {
  experimentStatus: ExperimentStatus;
  /** True when no execution of the experiment is still pending or running. */
  settled: boolean;
  selectedCandidateId: string | null;
  candidate: ExperimentCandidateRecord;
  metrics: CandidateMetrics | null;
  constraints: ExperimentConstraints;
  primaryReplicateBatchId: string | null;
  evidenceVerdict?: AuthorizationInput["evidenceVerdict"];
  pairedCases?: number | null;
}): { allowed: boolean; blockers: string[]; warnings: string[] } {
  const report = verifyExperimentAuthorization({
    candidate: input.candidate,
    metrics: input.metrics,
    constraints: input.constraints,
    passThreshold: null,
    experimentStatus: input.experimentStatus,
    settled: input.settled,
    evidenceVerdict: input.evidenceVerdict ?? null,
    pairedCases: input.pairedCases ?? null,
  });

  const blockers = [...report.blockers];
  if (input.primaryReplicateBatchId === null) {
    blockers.push("This candidate has no sealed batch to promote from.");
  }
  if (input.selectedCandidateId !== null && input.selectedCandidateId !== input.candidate.id) {
    // Not a blocker: an explicit candidateId is a legitimate override. It is
    // reported so a reviewer can see the decision replaced an earlier one.
    report.warnings.push(
      "Another candidate of this experiment is currently selected; promoting this one replaces that record.",
    );
  }

  return { allowed: blockers.length === 0, blockers, warnings: report.warnings };
}
