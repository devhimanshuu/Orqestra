/**
 * Shared display pieces for the optimization surfaces.
 *
 * Everything here is presentational and derives from stored rows only: a chip
 * never claims a result the session does not have, and every number is labelled
 * with what it is (budget vs used, estimate vs measured).
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground border-border",
  QUEUED: "bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400",
  RUNNING: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  WAITING_FOR_REVIEW: "bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400",
  COMPLETED: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  PARTIALLY_COMPLETED: "bg-teal-500/10 text-teal-600 border-teal-500/20 dark:text-teal-400",
  FAILED: "bg-destructive/10 text-destructive border-destructive/20",
  CANCELLED: "bg-muted text-muted-foreground border-border",
};

export function OptimizationStatusChip({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("whitespace-nowrap text-[10.5px] font-medium", STATUS_STYLES[value] ?? STATUS_STYLES["DRAFT"])}
      data-testid="optimization-status"
    >
      {value.replace(/_/g, " ").toLowerCase()}
    </Badge>
  );
}

const DECISION_STYLES: Record<string, string> = {
  ACCEPT: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  REJECT: "bg-destructive/10 text-destructive border-destructive/20",
  INCONCLUSIVE: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
};

export function DecisionChip({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <Badge variant="outline" className="text-[10.5px] font-medium text-muted-foreground">
        pending
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn("text-[10.5px] font-medium", DECISION_STYLES[value])}>
      {value.toLowerCase()}
    </Badge>
  );
}

export function MetricValue({ value, unit }: { value: number | null | undefined; unit?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  const rounded = value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(value >= 1 ? 2 : 4);
  return (
    <span className="tabular-nums">
      {rounded}
      {unit === undefined ? null : <span className="text-muted-foreground">{unit}</span>}
    </span>
  );
}

/** "12 / 60" for a used-vs-budget pair, where the budget may be unbounded. */
export function Budget({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">
        {used.toLocaleString()}
        <span className="text-muted-foreground">
          {" / "}
          {limit === null ? "∞" : limit.toLocaleString()}
        </span>
      </span>
    </div>
  );
}

export function StopReasonNote({ reason }: { reason: string | null }) {
  if (reason === null) {
    return null;
  }
  const copy: Record<string, string> = {
    max_iterations: "Stopped at the iteration limit.",
    max_candidates: "Stopped at the candidate limit.",
    max_runs: "Stopped at the run budget.",
    token_budget: "Stopped at the token budget.",
    cost_budget: "Stopped at the cost budget.",
    time_budget: "Stopped at the time budget.",
    no_hypotheses: "No further hypothesis could be derived from the evidence.",
    no_failures_found: "The evidence batch showed no failures to work on.",
    no_improvement: "No candidate improved on the baseline.",
    consecutive_invalid: "Repeated candidates failed validation.",
    cancelled: "Cancelled by a user.",
    infrastructure_failure: "Stopped by an infrastructure failure.",
    awaiting_review: "Parked for human review.",
  };
  return (
    <p className="text-xs text-muted-foreground" data-testid="optimization-stop-reason">
      {copy[reason] ?? `Stopped: ${reason}.`}
    </p>
  );
}

/** The cycle this feature implements, stated once where a reader will look. */
export function LoopPrinciple() {
  return (
    <p className="font-mono text-[10.5px] text-muted-foreground">
      analyze → hypothesize → mutate → validate → evaluate → compare → accept or reject → repeat
    </p>
  );
}
