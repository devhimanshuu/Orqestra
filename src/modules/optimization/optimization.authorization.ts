/**
 * Review and promotion authorization.
 *
 * These are the two places a human decides something the loop cannot:
 *
 *   review    — may this candidate's change set be evaluated at all? (only when
 *               the session asked for approval before evaluation)
 *   promotion — may this candidate become the harness's current version?
 *
 * Both are pure functions over rows the caller already loaded, so the service,
 * the API response and the tests all read the same rule text. The rules are
 * deliberately conservative: an approval requires a *validated* candidate, and a
 * promotion requires a settled session, a measured candidate and an acceptance
 * verdict. An explicit override exists for promotion, and it must carry a reason:
 * the audit trail then shows that a human accepted a known trade-off rather than
 * the platform claiming evidence it does not have.
 */

import type {
  OptimizationCandidateRecord,
  OptimizationStatus,
} from "./optimization.types";
import { isTerminalOptimizationStatus } from "./optimization.types";

export interface AuthorizationCheck {
  label: string;
  status: "ok" | "warning" | "blocked";
  detail: string;
}

export interface OptimizationReviewReport {
  canApprove: boolean;
  canReject: boolean;
  blockers: string[];
  checks: AuthorizationCheck[];
  /** The candidate carries the definition a resumed pass would publish. */
  hasDefinition: boolean;
}

export function verifyOptimizationReview(input: {
  sessionStatus: OptimizationStatus;
  candidate: OptimizationCandidateRecord;
}): OptimizationReviewReport {
  const checks: AuthorizationCheck[] = [];
  const blockers: string[] = [];
  const { candidate } = input;

  const awaiting = input.sessionStatus === "WAITING_FOR_REVIEW";
  if (awaiting) {
    checks.push({
      label: "Session awaiting review",
      status: "ok",
      detail: "The loop has parked this session until a candidate is reviewed.",
    });
  } else {
    const message = `This session is ${input.sessionStatus.toLowerCase()}, so there is nothing to approve right now.`;
    blockers.push(message);
    checks.push({ label: "Session awaiting review", status: "blocked", detail: message });
  }

  const validation = candidate.validation;
  if (validation === null) {
    const message = "This candidate has not been validated, so its graph is unknown.";
    blockers.push(message);
    checks.push({ label: "Candidate validation", status: "blocked", detail: message });
  } else if (!validation.ok) {
    const message = `This candidate failed validation: ${validation.issues
      .map((issue) => issue.message)
      .join("; ")}`;
    blockers.push(message);
    checks.push({ label: "Candidate validation", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Candidate validation",
      status: "ok",
      detail: `The graph is valid: ${validation.nodeCount} node(s), ${validation.edgeCount} edge(s), entry "${validation.entryNode ?? "?"}".`,
    });
  }

  const hasDefinition = candidate.pendingDefinition !== null && candidate.pendingDefinition !== undefined;
  if (!hasDefinition) {
    const message =
      "This candidate carries no definition to publish, so approving it could not be resumed.";
    blockers.push(message);
    checks.push({ label: "Reviewable definition", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Reviewable definition",
      status: "ok",
      detail: "The exact definition being approved is stored with the candidate.",
    });
  }

  if (candidate.evaluationBatchId !== null) {
    const message = "This candidate has already been evaluated; approve the pending one instead.";
    blockers.push(message);
    checks.push({ label: "Still pending", status: "blocked", detail: message });
  } else if (candidate.versionId !== null) {
    // A manually attached candidate: the version already exists, so approving
    // means "evaluate that exact version" rather than "publish a new one".
    checks.push({
      label: "Still pending",
      status: "ok",
      detail: `No evaluation has run for this candidate; it carries published version ${candidate.versionId}.`,
    });
  } else {
    checks.push({
      label: "Still pending",
      status: "ok",
      detail: "No version has been published and no evaluation has run for this candidate.",
    });
  }

  const risky = (candidate.changeSet ?? []).filter((change) => change.risk === "HIGH");
  if (risky.length > 0) {
    checks.push({
      label: "Change risk",
      status: "warning",
      detail: `${risky.length} high-risk change(s): ${risky.map((change) => change.target).join(", ")}.`,
    });
  }

  return {
    canApprove: blockers.length === 0,
    canReject: awaiting,
    blockers,
    checks,
    hasDefinition,
  };
}

export interface OptimizationPromotionReport {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  checks: AuthorizationCheck[];
}

export function verifyOptimizationPromotion(input: {
  sessionStatus: OptimizationStatus;
  candidate: OptimizationCandidateRecord;
  /** `force` turns a blocked verdict into a warning, and demands a reason. */
  override: boolean;
  overrideReason: string | null;
}): OptimizationPromotionReport {
  const checks: AuthorizationCheck[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { candidate } = input;

  if (isTerminalOptimizationStatus(input.sessionStatus)) {
    checks.push({
      label: "Session settled",
      status: "ok",
      detail: `The session is ${input.sessionStatus.toLowerCase()}; no execution is outstanding.`,
    });
  } else {
    const message = `Promotion needs a settled session; this one is ${input.sessionStatus.toLowerCase()}.`;
    blockers.push(message);
    checks.push({ label: "Session settled", status: "blocked", detail: message });
  }

  if (candidate.metrics === null) {
    const message =
      "This candidate has no measured evaluation, so there is nothing to promote it on.";
    blockers.push(message);
    checks.push({ label: "Measured candidate", status: "blocked", detail: message });
  } else {
    const scored = candidate.decision?.scoredCases ?? candidate.metrics.scored;
    checks.push({
      label: "Measured candidate",
      status: "ok",
      detail: `${scored} scored case(s); pass rate ${format(candidate.metrics.passRate)}.`,
    });
  }

  if (candidate.versionId === null) {
    const message = "This candidate never produced an immutable harness version.";
    blockers.push(message);
    checks.push({ label: "Published version", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Published version",
      status: "ok",
      detail: `Candidate version ${candidate.versionId} is immutable and pinned to the harness.`,
    });
  }

  if (candidate.evaluationBatchId === null) {
    const message = "This candidate has no sealed evaluation batch to promote from.";
    blockers.push(message);
    checks.push({ label: "Sealed evidence", status: "blocked", detail: message });
  } else {
    checks.push({
      label: "Sealed evidence",
      status: "ok",
      detail: `Evidence batch ${candidate.evaluationBatchId} is sealed.`,
    });
  }

  const decision = candidate.decision;
  if (decision === null) {
    const message = "This candidate has no acceptance decision recorded.";
    blockers.push(message);
    checks.push({ label: "Acceptance verdict", status: "blocked", detail: message });
  } else if (decision.kind === "ACCEPT") {
    checks.push({
      label: "Acceptance verdict",
      status: "ok",
      detail: decision.reasons[0] ?? "The acceptance policy accepted this candidate.",
    });
  } else if (decision.kind === "INCONCLUSIVE") {
    const message =
      decision.reasons[0] ??
      "The evidence was inconclusive: the candidate was not shown to improve on the baseline.";
    warnings.push(message);
    checks.push({ label: "Acceptance verdict", status: "warning", detail: message });
  } else {
    const message = `The acceptance policy rejected this candidate: ${decision.reasons[0] ?? "no reason recorded"}`;
    blockers.push(message);
    checks.push({ label: "Acceptance verdict", status: "blocked", detail: message });
  }

  if (decision !== null && decision.violations.length > 0) {
    const message = `${decision.violations.length} hard constraint(s) were violated: ${decision.violations
      .map((violation) => violation.constraint)
      .join(", ")}.`;
    blockers.push(message);
    checks.push({ label: "Hard constraints", status: "blocked", detail: message });
  } else if (decision !== null) {
    checks.push({
      label: "Hard constraints",
      status: "ok",
      detail: "No configured hard constraint was violated.",
    });
  }

  if (decision !== null && decision.evidenceCompleteness !== "complete") {
    const message = `Evidence is ${decision.evidenceCompleteness}: the candidate's evaluation did not cover the whole dataset.`;
    warnings.push(message);
    checks.push({ label: "Evidence coverage", status: "warning", detail: message });
  }
  if (decision !== null && decision.evidenceStrength === "indicative") {
    const message =
      "The improvement is indicative rather than established: the sample is too small to prove a difference.";
    warnings.push(message);
    checks.push({ label: "Evidence strength", status: "warning", detail: message });
  }

  if (blockers.length === 0) {
    return { allowed: true, blockers, warnings, checks };
  }
  if (!input.override) {
    return { allowed: false, blockers, warnings, checks };
  }
  if (input.overrideReason === null || input.overrideReason.trim() === "") {
    const message = "An override must carry a reason, so the decision stays auditable.";
    blockers.push(message);
    checks.push({ label: "Override", status: "blocked", detail: message });
    return { allowed: false, blockers, warnings, checks };
  }
  // Nothing measured, or no version at all, is not a trade-off a human can accept:
  // there would be no artifact to promote.
  const fatal = blockers.filter(isNotOverrideable);
  if (fatal.length > 0) {
    return { allowed: false, blockers, warnings, checks };
  }
  for (const blocker of blockers) {
    warnings.push(`Override accepted: ${blocker}`);
  }
  checks.push({
    label: "Override",
    status: "warning",
    detail: `Promoted by explicit override: ${input.overrideReason.trim()}`,
  });
  return { allowed: true, blockers: [], warnings, checks };
}

function isNotOverrideable(blocker: string): boolean {
  return (
    blocker.startsWith("This candidate has no measured") ||
    blocker.startsWith("This candidate never produced")
  );
}

function format(value: number | null): string {
  return value === null ? "not measured" : value.toFixed(3);
}
