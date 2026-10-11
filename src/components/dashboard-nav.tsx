import Link from "next/link";

const SECTIONS = [
  { href: "/dashboard", label: "Projects" },
  { href: "/dashboard/runs", label: "Runs" },
  { href: "/dashboard/datasets", label: "Datasets" },
  { href: "/dashboard/evaluators", label: "Evaluators" },
  { href: "/dashboard/evaluations", label: "Evaluations" },
] as const;

/**
 * The dashboard's top-level sections.
 *
 * Deliberately plain links (no client state): each page server-renders its own
 * header and breadcrumb, so navigation works before hydration.
 */
export function DashboardNav({ current }: { current: string }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Sections">
      {SECTIONS.map((section) => {
        const active = section.href === current;
        return (
          <Link
            key={section.href}
            href={section.href}
            className={
              active
                ? "rounded-md bg-muted px-2.5 py-1 font-medium text-foreground"
                : "rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
