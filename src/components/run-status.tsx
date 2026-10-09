import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Run status presentation.
 *
 * Status is communicated by an icon + a word, never colour alone, so the states
 * stay readable for colour-blind users and in greyscale.
 */

const STATUS_META: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2; spin?: boolean }
> = {
  QUEUED: { label: "Queued", className: "bg-sky-500/10 text-sky-700 dark:text-sky-400", icon: Clock },
  RUNNING: {
    label: "Running",
    className: "bg-primary/10 text-primary",
    icon: Loader2,
    spin: true,
  },
  SUCCEEDED: {
    label: "Completed",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  FAILED: { label: "Failed", className: "bg-destructive/10 text-destructive", icon: XCircle },
  CANCELLED: { label: "Cancelled", className: "bg-muted text-muted-foreground", icon: Ban },
  TIMED_OUT: {
    label: "Timed out",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: AlertTriangle,
  },
};

export const RUN_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_META).map(([status, meta]) => [status, meta.label]),
);

export function RunStatusChip({ status, className }: { status: string; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META["QUEUED"];
  const Icon = meta?.icon ?? Clock;
  return (
    <span
      data-testid={`run-status-${status.toLowerCase()}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        meta?.className,
        className,
      )}
    >
      <Icon className={cn("h-3 w-3", meta?.spin === true ? "animate-spin" : "")} />
      {meta?.label ?? status}
    </span>
  );
}

/** 12400 → "12.4s"; 950 → "950ms"; null → "—". */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) {
    return "—";
  }
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/** Compact relative time for tables ("2m ago"), absolute for old runs. */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const date = typeof value === "string" ? new Date(value) : value;
  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 60_000) {
    return "just now";
  }
  if (deltaMs < 3_600_000) {
    return `${Math.floor(deltaMs / 60_000)}m ago`;
  }
  if (deltaMs < 86_400_000) {
    return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  }
  if (deltaMs < 7 * 86_400_000) {
    return `${Math.floor(deltaMs / 86_400_000)}d ago`;
  }
  return date.toLocaleDateString();
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

export function formatCost(costUsd: number | null | undefined, unknownCost = false): string {
  if (costUsd === null || costUsd === undefined) {
    return "—";
  }
  const base = costUsd === 0 ? "$0.00" : `$${costUsd.toFixed(costUsd < 0.01 ? 5 : 4)}`;
  return unknownCost ? `${base}+` : base;
}
