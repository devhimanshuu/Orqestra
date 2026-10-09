import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  VALID: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  INVALID: "bg-destructive/10 text-destructive",
  ARCHIVED: "bg-muted text-muted-foreground line-through decoration-muted-foreground/50",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  VALID: "Valid",
  INVALID: "Invalid",
  ARCHIVED: "Archived",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      data-testid={`status-${status.toLowerCase()}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT,
        className,
      )}
    >
      {status === "VALID" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
      {status === "INVALID" && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
