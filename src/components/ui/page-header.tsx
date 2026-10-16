import { cn } from "cn";

interface PageHeaderProps {
  title: string;
  /** Node rather than string: descriptions often carry an emphasised detail. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Consistent page-level header: title, optional description, and an actions
 * slot on the right. Every list and detail page uses this instead of ad-hoc
 * header markup.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-1",
        actions && "sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">{actions}</div>}
    </header>
  );
}
