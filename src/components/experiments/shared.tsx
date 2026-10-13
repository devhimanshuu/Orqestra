import { cn } from "@/lib/utils";
import type { EvidenceVerdict } from "@/modules/experiments/experiment.statistics";
import type { ConstraintCheck } from "@/modules/experiments/experiment.objective";
import type { MetricDirection } from "@/modules/experiments/experiment.types";

/**
 * Presentation helpers for the experiment surfaces.
 *
 * Pure functions and tiny presentational components — no hooks, no data access —
 * so server pages and client views share them.
 *
 * Two rules are encoded here rather than in each view:
 *
 *  1. **Never colour alone.** Every verdict carries text (and a symbol), so
 *     "improved", "regressed", "inconclusive" and "not measurable" are still
 *     distinguishable without perceiving colour.
 *  2. **Missing is not zero.** A `null` metric renders as an em dash with the
 *     reason, never as "0" or "100%".
 */

export const METRIC_LABELS: Record<string, string> = {
  evaluation_score: "Mean evaluation score",
  pass_rate: "Pass rate",
  failure_rate: "Failure rate",
  median_latency_ms: "Median latency",
  p95_latency_ms: "p95 latency",
  average_total_tokens: "Average tokens per execution",
  total_tokens: "Total tokens",
  estimated_cost_usd: "Estimated cost",
  tool_calls_per_case: "Tool calls per case",
};

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key.replace(/_/g, " ");
}

/** Formats a value for a metric key, in the unit that metric is reported in. */
export function formatMetricValue(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  switch (key) {
    case "pass_rate":
    case "failure_rate":
      return `${Math.round(value * 100)}%`;
    case "median_latency_ms":
    case "p95_latency_ms":
      return `${Math.round(value)} ms`;
    case "average_total_tokens":
    case "total_tokens":
      return `${Math.round(value)} tokens`;
    case "estimated_cost_usd":
      return value === 0 ? "$0.00" : value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
    case "tool_calls_per_case":
      return value.toFixed(2);
    default:
      return value.toFixed(3);
  }
}

export function directionLabel(direction: MetricDirection): string {
  return direction === "maximize" ? "maximize (higher is better)" : "minimize (lower is better)";
}

const OUTCOME_STYLES: Record<string, string> = {
  improved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  regressed: "bg-destructive/10 text-destructive",
  unchanged: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const OUTCOME_LABELS: Record<string, string> = {
  improved: "improved",
  regressed: "regressed",
  unchanged: "unchanged",
  unknown: "not measured",
};

/** A metric movement: word first, then the numbers, so colour is decoration only. */
export function OutcomeBadge({
  direction,
  delta,
  deltaPercent,
  digits = 3,
  className,
}: {
  direction: "improved" | "regressed" | "unchanged" | "unknown";
  delta?: number | null;
  deltaPercent?: number | null;
  digits?: number;
  className?: string;
}) {
  const symbol = direction === "improved" ? "▲" : direction === "regressed" ? "▼" : direction === "unchanged" ? "=" : "?";
  return (
    <span
      data-testid={`experiment-outcome-${direction}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        OUTCOME_STYLES[direction] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden>{symbol}</span>
      <span>{OUTCOME_LABELS[direction] ?? direction}</span>
      {delta !== null && delta !== undefined && Number.isFinite(delta) ? (
        <span className="font-mono tabular-nums">
          {delta > 0 ? "+" : ""}
          {delta.toFixed(digits)}
          {deltaPercent !== null && deltaPercent !== undefined && Number.isFinite(deltaPercent)
            ? ` (${deltaPercent > 0 ? "+" : ""}${deltaPercent.toFixed(1)}%)`
            : ""}
        </span>
      ) : null}
    </span>
  );
}

/** Constraint status: within limit, violated, or not measurable yet — never silent. */
export function ConstraintChip({ check }: { check: ConstraintCheck }) {
  const satisfied = check.satisfied;
  const symbol = satisfied === true ? "✓" : satisfied === false ? "✕" : "?";
  const label = satisfied === true ? "within limit" : satisfied === false ? "violated" : "not measurable";
  return (
    <span
      data-testid={`experiment-constraint-${satisfied === true ? "ok" : satisfied === false ? "violated" : "unknown"}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]",
        satisfied === true
          ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
          : satisfied === false
            ? "border-destructive/40 text-destructive"
            : "border-dashed text-muted-foreground",
      )}
      title={check.explanation}
    >
      <span aria-hidden>{symbol}</span>
      <span className="font-medium">{check.label}</span>
      <span className="font-mono tabular-nums">
        {check.actual === null ? "—" : check.actual.toFixed(check.unit === "ratio" ? 3 : 2)}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

const VERDICT_TEXT: Record<EvidenceVerdict, string> = {
  supported_improvement: "statistically supported improvement",
  supported_regression: "statistically supported regression",
  inconclusive: "inconclusive",
  insufficient_sample: "insufficient sample",
  no_difference: "no difference detected",
};

const VERDICT_STYLES: Record<EvidenceVerdict, string> = {
  supported_improvement: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  supported_regression: "bg-destructive/10 text-destructive",
  inconclusive: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  insufficient_sample: "bg-muted text-muted-foreground",
  no_difference: "bg-muted text-muted-foreground",
};

/**
 * The statistical verdict, always spelled out.
 *
 * "Inconclusive" and "insufficient sample" are first-class results here: a
 * leaderboard that reports certainty it does not have is worse than one that
 * reports none.
 */
export function EvidenceChip({
  verdict,
  className,
}: {
  verdict: EvidenceVerdict;
  className?: string;
}) {
  return (
    <span
      data-testid={`experiment-evidence-${verdict}`}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        VERDICT_STYLES[verdict],
        className,
      )}
    >
      {VERDICT_TEXT[verdict]}
    </span>
  );
}

const EXPERIMENT_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  QUEUED: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  RUNNING: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  PAUSED: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PARTIALLY_COMPLETED: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  FAILED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

export function ExperimentStatusChip({ value, className }: { value: string; className?: string }) {
  return (
    <span
      data-testid={`experiment-status-${value.toLowerCase()}`}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide",
        EXPERIMENT_STYLES[value] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {value.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

/** A labelled number, with an explicit dash when it was never measured. */
export function MetricCell({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm tabular-nums">{value}</span>
      {hint !== undefined ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A 0…1 progress bar with the percentage spelled out. */
export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(percent) ? percent : 0));
  return (
    <div className="flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            clamped >= 1 ? "bg-emerald-500" : "bg-sky-500",
          )}
          style={{ width: `${clamped * 100}%` }}
        />
      </span>
      <span className="font-mono text-xs tabular-nums">{Math.round(clamped * 100)}%</span>
      {label !== undefined ? <span className="text-[10.5px] text-muted-foreground">{label}</span> : null}
    </div>
  );
}
