import { cn } from "@/lib/utils";

/**
 * Shared presentation helpers for the evaluation surfaces.
 *
 * Pure functions and tiny presentational components — no hooks, no data access —
 * so both server pages and client views can use them.
 */

export function formatScore(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(digits);
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(value * 100)}%`;
}

export function formatDelta(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value === 0) {
    return "$0.00";
  }
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

const BATCH_STYLES: Record<string, string> = {
  PENDING: "bg-muted text-muted-foreground",
  RUNNING: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PARTIALLY_COMPLETED: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  FAILED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

const CASE_STYLES: Record<string, string> = {
  PENDING: "bg-muted text-muted-foreground",
  RUNNING: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  FAILED: "bg-destructive/10 text-destructive",
  SKIPPED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-muted text-muted-foreground",
};

const AGGREGATE_STYLES: Record<string, string> = {
  COMPLETE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  INCOMPLETE: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  FAILED: "bg-destructive/10 text-destructive",
};

const RESULT_STYLES: Record<string, string> = {
  COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  ERROR: "bg-destructive/10 text-destructive",
  SKIPPED: "bg-muted text-muted-foreground",
};

export function StatusChip({
  value,
  kind = "batch",
  className,
}: {
  value: string;
  kind?: "batch" | "case" | "aggregate" | "result";
  className?: string;
}) {
  const styles =
    kind === "case"
      ? CASE_STYLES
      : kind === "aggregate"
        ? AGGREGATE_STYLES
        : kind === "result"
          ? RESULT_STYLES
          : BATCH_STYLES;
  return (
    <span
      // Kind-scoped so a page with a batch and its cases can be queried precisely.
      data-testid={`eval-${kind}-status-${value.toLowerCase()}`}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide",
        styles[value] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {value.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

/** A 0…1 score rendered as a small bar plus the number, or an honest dash. */
export function ScoreBar({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            value >= 0.75 ? "bg-emerald-500" : value >= 0.4 ? "bg-amber-500" : "bg-destructive",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="font-mono text-xs tabular-nums">{formatScore(value)}</span>
    </span>
  );
}

export function StatCard({
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
    <div className={cn("flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-lg tabular-nums">{value}</span>
      {hint !== undefined ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Pretty-printed JSON, bounded so a huge trace cannot blow up the page. */
export function JsonBlock({
  value,
  maxLength = 4_000,
  className,
}: {
  value: unknown;
  maxLength?: number;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const truncated = text.length > maxLength;
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto rounded-md border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
        className,
      )}
    >
      {truncated ? `${text.slice(0, maxLength)}\n… (${text.length - maxLength} more characters)` : text}
    </pre>
  );
}

/** Parses a JSON textarea value, returning a user-facing error instead of throwing. */
export function parseJsonField(
  text: string,
  label: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === "") {
    return { ok: false, error: `${label} is required` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: `${label} must be valid JSON` };
  }
}
