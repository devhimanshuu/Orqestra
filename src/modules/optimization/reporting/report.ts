/**
 * Optimization report.
 *
 * The report is assembled from persisted rows only — metrics, decisions, events —
 * so an exported report can never claim something the database does not hold. It
 * carries the evidence chain (findings → hypotheses → candidates → decisions) and
 * states the stopping reason, because "why did this stop" is the first question a
 * developer asks of a bounded process.
 *
 * Two output shapes: structured JSON (the API's default) and Markdown (readable,
 * and safe to paste into a review).
 */

import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type {
  FailureFindingRecord,
  ImprovementHypothesisRecord,
  OptimizationCandidateRecord,
  OptimizationDecisionKind,
  OptimizationReport,
  OptimizationSessionRecord,
} from "../optimization.types";
import { readBatchMetric } from "../policies/acceptance";

/**
 * Builds the structured report.
 *
 * `baselineMetrics` is passed explicitly (rather than read from the session's
 * snapshot) so the report always shows the *stored* baseline numbers the policy
 * actually compared against.
 */
export function buildOptimizationReport(input: {
  session: OptimizationSessionRecord;
  findings: readonly FailureFindingRecord[];
  hypotheses: readonly ImprovementHypothesisRecord[];
  candidates: readonly OptimizationCandidateRecord[];
  baselineMetrics: BatchMetrics | null;
  /** Candidate ids in the order the loop created them. */
  recommendation: { candidateId: string | null; label: string | null; rationale: string[] };
}): OptimizationReport {
  const { session, candidates } = input;
  const byIteration = new Map<number, OptimizationCandidateRecord[]>();
  for (const candidate of candidates) {
    const bucket = byIteration.get(candidate.iteration);
    if (bucket === undefined) {
      byIteration.set(candidate.iteration, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  const accepted: OptimizationReport["accepted"] = [];
  const rejected: OptimizationReport["rejected"] = [];
  for (const candidate of candidates) {
    if (candidate.decisionKind === "ACCEPT" && candidate.versionId !== null) {
      accepted.push({
        candidateId: candidate.id,
        label: candidate.label,
        versionId: candidate.versionId,
        reasons: candidate.decision?.reasons ?? [],
      });
    } else if (candidate.decisionKind === "REJECT") {
      rejected.push({
        candidateId: candidate.id,
        label: candidate.label,
        reasons: candidate.decision?.reasons ?? [],
      });
    }
  }

  const durationMs =
    session.startedAt === null
      ? null
      : (session.completedAt ?? new Date()).getTime() - session.startedAt.getTime();

  return {
    kind: "orqestra.optimization-report",
    sessionId: session.id,
    status: session.status,
    stopReason: (session.stopReason as OptimizationReport["stopReason"]) ?? null,
    objective: session.objective,
    constraints: session.constraints,
    baseline: {
      harnessVersionId: session.baselineVersionId,
      harnessVersion: session.configSnapshot?.baseline.harnessVersion ?? 0,
      metrics: input.baselineMetrics,
    },
    iterations: [...byIteration.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([iteration, entries]) => {
        const hypothesisId = entries.find((entry) => entry.hypothesisId !== null)?.hypothesisId ?? null;
        const hypothesis =
          hypothesisId === null
            ? null
            : (input.hypotheses.find((entry) => entry.id === hypothesisId)?.title ?? null);
        return {
          iteration,
          hypothesis,
          candidates: entries.map((entry) => ({
            candidateId: entry.id,
            label: entry.label,
            status: entry.status,
            decision: entry.decisionKind,
            primaryDelta: primaryDelta(entry, input.baselineMetrics, session),
            violations: (entry.decision?.violations ?? []).map((violation) => violation.message),
          })),
        };
      }),
    findings: input.findings.map((finding) => ({
      category: finding.category,
      summary: finding.summary,
      frequency: finding.frequency,
    })),
    accepted,
    rejected,
    recommendation: {
      candidateId: input.recommendation.candidateId,
      label: input.recommendation.label,
      rationale: input.recommendation.rationale,
    },
    usage: {
      runs: session.runCount,
      agentTokens: session.tokenUsage,
      analyzerTokens: session.analyzerTokenUsage,
      estimatedCostUsd: session.estimatedCostUsd,
      durationMs,
    },
    generatedAt: new Date().toISOString(),
  };
}

function primaryDelta(
  candidate: OptimizationCandidateRecord,
  baseline: BatchMetrics | null,
  session: OptimizationSessionRecord,
): number | null {
  const primary = session.objective.primary;
  const baselineValue = readBatchMetric(baseline, primary.metric);
  const candidateValue = readBatchMetric(candidate.metrics, primary.metric);
  if (baselineValue === null || candidateValue === null) {
    return null;
  }
  const raw = candidateValue - baselineValue;
  return primary.direction === "maximize" ? raw : -raw;
}

/** A readable rendering of the same report. No secrets, no raw payloads. */
export function renderOptimizationReportMarkdown(report: OptimizationReport): string {
  const lines: string[] = [];
  lines.push(`# Optimization report — ${report.sessionId}`);
  lines.push("");
  lines.push(`- Status: **${report.status}**`);
  lines.push(`- Stop reason: ${report.stopReason ?? "(still running)"}`);
  lines.push(
    `- Objective: ${report.objective.primary.direction} ${report.objective.primary.metric} (min improvement ${(report.objective.minImprovementPct * 100).toFixed(1)}%)`,
  );
  lines.push(
    `- Baseline: harness version ${report.baseline.harnessVersion} (${report.baseline.harnessVersionId})`,
  );
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) {
    lines.push("_No weaknesses were found in the source evaluation._");
  } else {
    for (const finding of report.findings) {
      lines.push(`- **${finding.category}** — ${finding.summary}${finding.frequency === null ? "" : ` (${finding.frequency})`}`);
    }
  }
  lines.push("");
  lines.push("## Candidates");
  if (report.iterations.length === 0) {
    lines.push("_No candidates were created._");
  } else {
    // Accepted candidates name the immutable version a reviewer would be
    // promoting, so every verdict in this report is traceable to one version.
    const publishedVersions = new Map(
      report.accepted.map((entry) => [entry.candidateId, entry.versionId] as const),
    );
    for (const iteration of report.iterations) {
      lines.push(`### Iteration ${iteration.iteration}${iteration.hypothesis === null ? "" : ` — ${iteration.hypothesis}`}`);
      for (const candidate of iteration.candidates) {
        const delta = candidate.primaryDelta === null ? "n/a" : candidate.primaryDelta.toFixed(4);
        const version = publishedVersions.get(candidate.candidateId);
        lines.push(
          `- **${candidate.label}** — ${candidate.status}, decision ${candidate.decision ?? "pending"}, primary Δ ${delta}${version === undefined ? "" : `, published as version ${version}`}`,
        );
        for (const violation of candidate.violations) {
          lines.push(`  - violated: ${violation}`);
        }
      }
      lines.push("");
    }
  }
  lines.push("## Decisions");
  if (report.accepted.length === 0 && report.rejected.length === 0) {
    lines.push("_No candidate reached a decision._");
  } else {
    for (const candidate of report.accepted) {
      lines.push(`- ACCEPT **${candidate.label}** → version ${candidate.versionId}`);
      for (const reason of candidate.reasons) {
        lines.push(`  - ${reason}`);
      }
    }
    for (const candidate of report.rejected) {
      lines.push(`- REJECT **${candidate.label}**`);
      for (const reason of candidate.reasons) {
        lines.push(`  - ${reason}`);
      }
    }
  }
  lines.push("");
  lines.push("## Recommendation");
  if (report.recommendation.candidateId === null) {
    lines.push("_No candidate is eligible for promotion._");
  } else {
    lines.push(`**${report.recommendation.label}** (${report.recommendation.candidateId})`);
  }
  for (const reason of report.recommendation.rationale) {
    lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push("## Usage");
  lines.push(`- Runs: ${report.usage.runs}`);
  lines.push(`- Agent tokens: ${report.usage.agentTokens}`);
  lines.push(`- Analyzer tokens: ${report.usage.analyzerTokens}`);
  lines.push(`- Estimated cost: $${report.usage.estimatedCostUsd.toFixed(4)}`);
  lines.push(
    `- Duration: ${report.usage.durationMs === null ? "n/a" : `${Math.round(report.usage.durationMs / 1000)}s`}`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Decision helper for callers that only need the verdict word. */
export function decisionLabel(kind: OptimizationDecisionKind | null): string {
  if (kind === null) {
    return "pending";
  }
  return kind === "ACCEPT" ? "accepted" : kind === "REJECT" ? "rejected" : "inconclusive";
}
