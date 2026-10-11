"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  GitCompare,
  Minus,
  Trophy,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/components/run-status";
import { cn } from "@/lib/utils";
import { ScoreBar, StatusChip, formatDelta, formatRate, formatScore } from "./shared";

export interface ComparableBatchOption {
  id: string;
  label: string | null;
  status: string;
  harnessName: string;
  harnessVersionLabel: number;
  datasetName: string;
  datasetVersion: number;
  caseCount: number;
  meanScore: number | null;
  passRate: number | null;
  createdAt: string;
}

interface SideHarness {
  id: string;
  versionId: string;
  version: number;
  name: string;
  passRate: number | null;
  passThreshold: number | null;
  status: string;
}

interface ComparisonResponse {
  baseline: {
    id: string;
    label: string | null;
    harnessVersionLabel: number | null;
    status: string;
  };
  candidate: {
    id: string;
    label: string | null;
    harnessVersionLabel: number | null;
    status: string;
  };
  compatible: boolean;
  sameDatasetVersion: boolean;
  sameHarnessVersion: boolean;
  alignment: {
    comparableCases: number;
    onlyInBaseline: string[];
    onlyInCandidate: string[];
    scoredOnBoth: number;
  };
  metrics: MetricDeltaDto[];
  regressions: Array<{
    caseKey: string;
    name: string | null;
    baselineScore: number | null;
    candidateScore: number | null;
    baselineStatus: string;
    candidateStatus: string;
    reason: string | null;
  }>;
  improvements: CaseMovementDto[];
  unchanged: number;
  caseMovements?: CaseMovementDto[];
  summary: {
    verdict:
      | "improved"
      | "regressed"
      | "mixed"
      | "unchanged"
      | "unknown";
    headline: string;
  };
  baselineHarness?: SideHarness;
  candidateHarness?: SideHarness;
}

interface MetricDeltaDto {
  key: string;
  label: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  deltaPercent: number | null;
  higherIsBetter: boolean;
  direction: "improved" | "regressed" | "unchanged" | "unknown";
  unit: "ratio" | "ms" | "tokens" | "usd" | "count" | "score";
}

interface CaseMovementDto {
  caseKey: string;
  name: string | null;
  baselinePassed: boolean | null;
  candidatePassed: boolean | null;
  baselineScore: number | null;
  candidateScore: number | null;
  direction: "improved" | "regressed" | "unchanged" | "unknown";
}

const VERDICT_STYLES: Record<string, string> = {
  improved:
    "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
  regressed: "border-destructive/40 bg-destructive/5 text-destructive",
  mixed:
    "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  unchanged: "border-border bg-muted/30 text-muted-foreground",
  unknown: "border-border bg-muted/30 text-muted-foreground",
};

function promotableHarnessId(
  result: ComparisonResponse | undefined,
): string | undefined {
  if (result == null) return undefined;
  if (
    result.baselineHarness == null ||
    result.candidateHarness == null ||
    result.baselineHarness.id !== result.candidateHarness.id
  ) {
    return undefined;
  }
  return result.baselineHarness.id;
}

/** Winning side currently selected in the promote panel, or null when the user has not chosen. */
function initialPromoteSide(
  result: ComparisonResponse | undefined,
): "baseline" | "candidate" | null {
  if (result == null) return null;
  const bl = result.baselineHarness;
  const ca = result.candidateHarness;
  if (bl == null || ca == null) return null;
  // Prefer the candidate when it is the clearly better side, otherwise prefer
  // whichever has the higher pass rate; fall back to candidate.
  if (ca.passRate == null && bl.passRate == null) return "candidate";
  if (ca.passRate == null) return "baseline";
  if (bl.passRate == null) return "candidate";
  return ca.passRate >= bl.passRate ? "candidate" : "baseline";
}

/** The run lab's comparison: two settled batches, aligned by stable case key.

 * The server refuses batches from different datasets and reports cases present
 * on only one side; this view never presents a number it cannot justify — an
 * unavailable delta renders as a dash, not a zero.
 */
export function ComparisonView({
  batches,
  initialBaseline,
  initialCandidate,
}: {
  batches: ComparableBatchOption[];
  initialBaseline: string;
  initialCandidate: string;
}) {
  const [baseline, setBaseline] = useState(
    initialBaseline !== ""
      ? initialBaseline
      : batches[0]?.id ?? "",
  );
  const [candidate, setCandidate] = useState(
    initialCandidate !== ""
      ? initialCandidate
      : batches[1]?.id ?? "",
  );
  const [includeCases, setIncludeCases] = useState(true);

  const compare = useMutation({
    mutationFn: () =>
      api.get<ComparisonResponse>(
        `/api/evaluations/compare?baseline=${encodeURIComponent(
          baseline,
        )}&candidate=${encodeURIComponent(candidate)}${
          includeCases ? "&includeCases=true" : ""
        }`,
      ),
  });

  const result = compare.data;

  const promote = useMutation<
    { harnessVersion: { version: number }; promotedFrom: number },
    Error,
    { batchId: string; passRateThreshold: number }
  >({
    mutationFn: (body) =>
      api.post(`/api/harnesses/${promotableHarnessId(result)}/promote`, body),
  });

  const [promoteSide, setPromoteSide] = useState<
    "baseline" | "candidate" | null
  >(() => initialPromoteSide(result));

  const [threshold, setThreshold] = useState<string>("");

  function effectiveThreshold() {
    const parsed = parseFloat(threshold);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.75;
  }

  function sidePassesThreshold(
    side: "baseline" | "candidate",
  ): boolean {
    const h =
      side === "baseline" ? result?.baselineHarness : result?.candidateHarness;
    if (h == null || h.passRate == null) return false;
    return h.passRate >= effectiveThreshold();
  }

  function canPromote() {
    if (promote.isPending) return false;
    if (promoteSide === null) return false;
    if (promotableHarnessId(result) == null) return false;
    return sidePassesThreshold(promoteSide);
  }

  function selectedBatchId() {
    if (promoteSide === "baseline") return result?.baseline.id ?? "";
    if (promoteSide === "candidate") return result?.candidate.id ?? "";
    return "";
  }

  const canShowPromotePanel =
    result != null &&
    result.baselineHarness != null &&
    result.candidateHarness != null &&
    result.baselineHarness.id === result.candidateHarness.id &&
    result.baselineHarness.version !== result.candidateHarness.version;

  const selectClass =
    "h-9 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="compare-baseline" className="text-[11px] text-muted-foreground">
            Baseline (before)
          </label>
          <select
            id="compare-baseline"
            value={baseline}
            onChange={(event) => setBaseline(event.target.value)}
            data-testid="compare-baseline"
            className={selectClass}
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.label ?? `#${batch.id.slice(-6)}`} —{" "}
                {batch.harnessName} v{batch.harnessVersionLabel} ·{" "}
                {batch.datasetName} v{batch.datasetVersion} ·{" "}
                {formatRelativeTime(batch.createdAt)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="compare-candidate" className="text-[11px] text-muted-foreground">
            Candidate (after)
          </label>
          <select
            id="compare-candidate"
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
            data-testid="compare-candidate"
            className={selectClass}
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.label ?? `#${batch.id.slice(-6)}`} —{" "}
                {batch.harnessName} v{batch.harnessVersionLabel} ·{" "}
                {batch.datasetName} v{batch.datasetVersion} ·{" "}
                {formatRelativeTime(batch.createdAt)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeCases}
            onChange={(event) => setIncludeCases(event.target.checked)}
            className="h-3.5 w-3.5 rounded border"
          />
          Per-case movement
        </label>
        <Button
          className="h-9 gap-1.5 text-xs"
          onClick={() => compare.mutate()}
          disabled={
            compare.isPending || baseline === "" || candidate === "" || baseline === candidate
          }
          data-testid="compare-submit"
        >
          <GitCompare className="h-3.5 w-3.5" />
          {compare.isPending ? "Comparing…" : "Compare"}
        </Button>
      </div>

      {compare.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage(compare.error)}
        </p>
      ) : null}

      {batches.length < 2 && result === undefined ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <p className="text-sm font-medium">Nothing to compare yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Finished evaluations appear here. Run the same dataset against two
            harness versions — for example a baseline and a candidate — to see
            regressions and metric deltas.
          </p>
        </div>
      ) : null}

      {result !== undefined ? (
        <div className="flex flex-col gap-5">
          <div
            className={cn(
              "rounded-lg border px-4 py-3",
              VERDICT_STYLES[result.summary.verdict],
            )}
          >
            <p className="text-sm font-semibold capitalize">
              Verdict: {result.summary.verdict}
            </p>
            <p className="mt-0.5 text-xs">{result.summary.headline}</p>
            <p className="mt-1.5 text-[11px] opacity-80">
              {result.sameHarnessVersion
                ? "Both batches pin the same harness version."
                : "Different harness versions are being compared."}{" "}
              {result.sameDatasetVersion
                ? "Same dataset version."
                : "Different dataset versions — cases are aligned by key."}{" "}
              {result.alignment.onlyInBaseline.length > 0
                ? `${result.alignment.onlyInBaseline.length} case(s) only in the baseline. `
                : ""}
              {result.alignment.onlyInCandidate.length > 0
                ? `${result.alignment.onlyInCandidate.length} case(s) only in the candidate.`
                : ""}
            </p>
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Metric deltas</h2>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Metric</th>
                    <th className="px-3 py-2 font-medium">Baseline</th>
                    <th className="px-3 py-2 font-medium">Candidate</th>
                    <th className="px-3 py-2 font-medium">Delta</th>
                    <th className="px-3 py-2 font-medium">%</th>
                  </tr>
                </thead>
                <tbody>
                  {result.metrics.map((metric) => (
                    <tr key={metric.key} className="border-b last:border-b-0">
                      <td className="px-3 py-2 text-xs">{metric.label}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {formatMetric(metric, metric.baseline)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {formatMetric(metric, metric.candidate)}
                      </td>
                      <td className="px-3 py-2">
                        <DirectionChip
                          direction={metric.direction}
                          value={formatDelta(metric.delta)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {metric.deltaPercent === null
                          ? "—"
                          : `${metric.deltaPercent > 0 ? "+" : ""}${metric.deltaPercent}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <h2 className="text-sm font-semibold">Regressions</h2>
              <span className="text-xs text-muted-foreground">
                passed before, fails now — {result.regressions.length} case(s)
              </span>
            </div>
            {result.regressions.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                No regressions. That is the headline this view was built to
                find.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Case</th>
                      <th className="px-3 py-2 font-medium">Baseline</th>
                      <th className="px-3 py-2 font-medium">Candidate</th>
                      <th className="px-3 py-2 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.regressions.map((entry) => (
                      <tr key={entry.caseKey} className="border-b last:border-b-0">
                        <td className="px-3 py-2 font-mono text-xs">
                          {entry.caseKey}
                        </td>
                        <td className="px-3 py-2">
                          <ScoreBar value={entry.baselineScore} />
                        </td>
                        <td className="px-3 py-2">
                          <ScoreBar value={entry.candidateScore} />
                        </td>
                        <td className="max-w-96 px-3 py-2 text-[11px] text-muted-foreground">
                          {entry.reason ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {result.improvements.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">
                Improvements{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  ({result.improvements.length})
                </span>
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {result.improvements.map((entry) => (
                  <span
                    key={entry.caseKey}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-400"
                  >
                    {entry.caseKey}:{" "}
                    {formatScore(entry.baselineScore)} →{" "}
                    {formatScore(entry.candidateScore)}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {result.caseMovements !== undefined &&
            result.caseMovements.length > 0 ? (
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
                  All case movements ({result.caseMovements.length};{" "}
                  {result.unchanged} unchanged)
                </summary>
                <div className="border-t">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Case</th>
                        <th className="px-3 py-2 font-medium">Baseline</th>
                        <th className="px-3 py-2 font-medium">Candidate</th>
                        <th className="px-3 py-2 font-medium">Direction</th>
                        <th className="px-3 py-2 font-medium">Pass</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.caseMovements.map((entry) => (
                        <tr key={entry.caseKey} className="border-b last:border-b-0">
                          <td className="px-3 py-2 font-mono text-xs">
                            {entry.caseKey}
                          </td>
                          <td className="px-3 py-2">
                            <ScoreBar value={entry.baselineScore} />
                          </td>
                          <td className="px-3 py-2">
                            <ScoreBar value={entry.candidateScore} />
                          </td>
                          <td className="px-3 py-2">
                            <DirectionChip
                              direction={entry.direction}
                              value={entry.direction}
                            />
                          </td>
                          <td className="px-3 py-2 text-[11px] text-muted-foreground">
                            {entry.baselinePassed === null
                              ? "—"
                              : entry.baselinePassed
                                ? "pass"
                                : "fail"}{" "}
                            →{" "}
                            {entry.candidatePassed === null
                              ? "—"
                              : entry.candidatePassed
                                ? "pass"
                                : "fail"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}

          <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>
              Baseline: <StatusChip value={result.baseline.status} />{" "}
              {result.baseline.label ?? `#${result.baseline.id.slice(-6)}`}
            </span>
            <span>
              Candidate: <StatusChip value={result.candidate.status} />{" "}
              {result.candidate.label ?? `#${result.candidate.id.slice(-6)}`}
            </span>
          </div>

          {canShowPromotePanel ? (
            <PromotePanel
              promoteSide={promoteSide}
              selectedBatchId={selectedBatchId()}
              onSideChange={(s) => setPromoteSide(s)}
              threshold={threshold}
              onThresholdChange={setThreshold}
              effectiveThreshold={effectiveThreshold()}
              promote={promote}
              canPromote={canPromote()}
              baselineVersion={result.baselineHarness?.version}
              candidateVersion={result.candidateHarness?.version}
              baselineStatus={result.baseline.status}
              candidateStatus={result.candidate.status}
              baselinePassRate={result.baselineHarness?.passRate}
              candidatePassRate={result.candidateHarness?.passRate}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PromotePanel({
  promoteSide,
  selectedBatchId,
  onSideChange,
  threshold,
  onThresholdChange,
  effectiveThreshold,
  promote,
  canPromote,
  baselineVersion,
  candidateVersion,
  baselineStatus,
  candidateStatus,
  baselinePassRate,
  candidatePassRate,
}: {
  promoteSide: "baseline" | "candidate" | null;
  selectedBatchId: string;
  onSideChange: (side: "baseline" | "candidate") => void;
  threshold: string;
  onThresholdChange: (value: string) => void;
  effectiveThreshold: number;
  promote: ReturnType<
    typeof useMutation<
      { harnessVersion: { version: number }; promotedFrom: number },
      Error,
      { batchId: string; passRateThreshold: number }
    >
  >;
  canPromote: boolean;
  baselineVersion: number | undefined;
  candidateVersion: number | undefined;
  baselineStatus: string | undefined;
  candidateStatus: string | undefined;
  baselinePassRate: number | null | undefined;
  candidatePassRate: number | null | undefined;
}) {
  const selectedVersion =
    promoteSide === "baseline" ? baselineVersion : candidateVersion;

  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <h2 className="text-sm font-semibold">Promote winning version</h2>
      </div>

      <p className="text-xs text-muted-foreground">
        When the comparison is done, promote the better harness version to be
        the agent&apos;s current version — once its pass rate clears the threshold
        below. Promotion only moves the harness forward to a newer version.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label className="text-[11px] text-muted-foreground">
            Promote which side
          </label>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => onSideChange("baseline")}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-xs text-left transition-colors",
                promoteSide === "baseline"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-muted",
              )}
            >
              Baseline v{baselineVersion}
            </button>
            <button
              type="button"
              onClick={() => onSideChange("candidate")}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 text-xs text-left transition-colors",
                promoteSide === "candidate"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-muted",
              )}
            >
              Candidate v{candidateVersion}
            </button>
          </div>
        </div>

        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <label htmlFor="promote-threshold" className="text-[11px] text-muted-foreground">
            Pass-rate threshold
          </label>
          <input
            id="promote-threshold"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={threshold}
            onChange={(event) => onThresholdChange(event.target.value)}
            placeholder="0.75"
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-mono outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <p className="text-[11px] text-muted-foreground">
            Minimum pass rate the winning batch must clear:{" "}
            <span className="font-mono text-foreground">{effectiveThreshold.toFixed(2)}</span>
          </p>
        </div>

        <Button
          variant="secondary"
          className="h-9 gap-1.5 text-xs"
          onClick={() =>
            promote.mutate({
              batchId: selectedBatchId,
              passRateThreshold: effectiveThreshold,
            })
          }
          disabled={!canPromote}
          data-testid="promote-submit"
        >
          {promote.isPending ? (
            "Promoting…"
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Promote {selectedVersion ?? "…"} →
            </>
          )}
        </Button>
      </div>

      {promote.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage(promote.error)}
        </p>
      ) : null}

      {promote.isSuccess ? (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          Promoted to v{promote.data?.harnessVersion.version} (was v
          {promote.data?.promotedFrom}).
        </p>
      ) : null}

      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground">Baseline:</span>
          <StatusChip value={baselineStatus ?? "unknown"} />
          {baselinePassRate != null ? (
            <span className="font-mono">
              pass rate {formatRate(baselinePassRate)}
              {baselinePassRate >= effectiveThreshold ? (
                <span className="text-emerald-600 dark:text-emerald-400"> · above threshold</span>
              ) : (
                <span className="text-destructive"> · below threshold</span>
              )}
            </span>
          ) : (
            <span className="font-mono">pass rate —</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground">Candidate:</span>
          <StatusChip value={candidateStatus ?? "unknown"} />
          {candidatePassRate != null ? (
            <span className="font-mono">
              pass rate {formatRate(candidatePassRate)}
              {candidatePassRate >= effectiveThreshold ? (
                <span className="text-emerald-600 dark:text-emerald-400"> · above threshold</span>
              ) : (
                <span className="text-destructive"> · below threshold</span>
              )}
            </span>
          ) : (
            <span className="font-mono">pass rate —</span>
          )}
        </div>
      </div>
    </section>
  );
}

function formatMetric(metric: MetricDeltaDto, value: number | null): string {
  if (value === null) return "—";
  switch (metric.unit) {
    case "ratio":
      return formatRate(value);
    case "usd":
      return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
    case "score":
      return formatScore(value);
    case "ms":
      return `${Math.round(value)}ms`;
    default:
      return value.toLocaleString();
  }
}

function DirectionChip({
  direction,
  value,
}: {
  direction: string;
  value: string;
}) {
  const base = "inline-flex items-center gap-1 font-mono text-xs";
  if (direction === "improved") {
    return (
      <span className={cn(base, "text-emerald-700 dark:text-emerald-400")}>
        <ArrowUpRight className="h-3 w-3" />
        {value}
      </span>
    );
  }
  if (direction === "regressed") {
    return (
      <span className={cn(base, "text-destructive")}>
        <ArrowDownRight className="h-3 w-3" />
        {value}
      </span>
    );
  }
  return (
    <span className={cn(base, "text-muted-foreground")}>
      <Minus className="h-3 w-3" />
      {direction === "unknown" ? "n/a" : value}
    </span>
  );
}
