"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  Menu,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { OrqestraMark } from "@/components/brand/orqestra-mark";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * Navigation model.
 *
 * Groups map to the product's conceptual layers. Every item links to a real,
 * implemented route — no dead links for planned features.
 * ------------------------------------------------------------------------- */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      { href: "/dashboard/runs", label: "Runs & Traces", icon: Terminal },
    ],
  },
  {
    label: "Observability",
    items: [
      { href: "/dashboard/datasets", label: "Datasets", icon: Database },
      { href: "/dashboard/evaluators", label: "Evaluators", icon: ShieldCheck },
      { href: "/dashboard/evaluations", label: "Evaluations", icon: BarChart3 },
    ],
  },
  {
    label: "Experimentation",
    items: [
      { href: "/dashboard/experiments", label: "Experiments", icon: FlaskConical },
      { href: "/dashboard/optimizations", label: "Optimizations", icon: Sparkles, badge: "New" },
    ],
  },
];

export interface AppShellProps {
  children: React.ReactNode;
  user: { name: string; email: string };
  workspace: { name: string; slug: string } | null;
}

/**
 * The authenticated application shell.
 *
 * Renders a persistent sidebar on desktop (collapsible), a slide-over drawer on
 * mobile, and a top bar with breadcrumbs context. The builder route
 * (`/dashboard/harnesses/[id]/builder`) is full-screen and opts out of the
 * shell entirely — detected via pathname.
 */
export function AppShell({ children, user, workspace }: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // ⌘K / Ctrl+K command palette
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // The builder is a full-screen engineering workspace — no shell chrome.
  // (Checked after hooks so the hook order is stable across renders.)
  const isBuilder = pathname.includes("/builder");
  if (isBuilder) {
    return <>{children}</>;
  }

  const userInitials =
    user.name
      .split(" ")
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "U";

  const workspaceName = workspace?.name ?? "Workspace";

  const allItems = NAV_GROUPS.flatMap((group) => group.items);
  const filteredItems = allItems.filter(
    (item) =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.href.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="flex min-h-dvh">
      {/* ─── Desktop Sidebar ─────────────────────────────────────────────── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 lg:flex",
          collapsed ? "w-16" : "w-60",
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5" title="Orqestra">
            <OrqestraMark className="h-6 w-6 shrink-0 text-sidebar-foreground" animated />
            {!collapsed && (
              <span className="text-sm font-bold tracking-tight text-sidebar-foreground">
                orqestra
              </span>
            )}
          </Link>
        </div>

        {/* Navigation groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Sections">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4">
              {!collapsed && (
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active =
                    item.href === "/dashboard"
                      ? pathname === "/dashboard"
                      : pathname.startsWith(item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                        )}
                        title={collapsed ? item.label : undefined}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!collapsed && (
                          <>
                            <span className="truncate">{item.label}</span>
                            {item.badge && (
                              <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">
                                {item.badge}
                              </span>
                            )}
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="flex w-full items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* ─── Mobile Drawer ───────────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-sidebar-border bg-sidebar shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Link
                href="/dashboard"
                className="flex items-center gap-2.5"
                onClick={() => setMobileOpen(false)}
              >
                <OrqestraMark className="h-6 w-6 text-sidebar-foreground" animated />
                <span className="text-sm font-bold tracking-tight text-sidebar-foreground">
                  orqestra
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Sections">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="mb-4">
                  <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const active =
                        item.href === "/dashboard"
                          ? pathname === "/dashboard"
                          : pathname.startsWith(item.href);
                      const Icon = item.icon;
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMobileOpen(false)}
                            className={cn(
                              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                              active
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                            {item.badge && (
                              <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">
                                {item.badge}
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <div className={cn("flex min-h-dvh flex-1 flex-col transition-[margin] duration-200", collapsed ? "lg:ml-16" : "lg:ml-60")}>
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:px-6">
          {/* Mobile menu trigger */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </Button>

          {/* Workspace indicator */}
          <div className="hidden items-center gap-2 sm:flex">
            <span className="text-xs font-medium text-muted-foreground">{workspaceName}</span>
          </div>

          {/* Search trigger */}
          <div className="mx-auto hidden w-full max-w-xs md:block">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/60"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Search…</span>
              <kbd className="ml-auto rounded border border-border/80 bg-background px-1.5 py-0.5 font-mono text-[10px]">
                ⌘K
              </kbd>
            </button>
          </div>

          {/* Right actions */}
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full border border-border/60 p-1 pr-2.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted/40"
                  aria-label="User menu"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                    {userInitials}
                  </span>
                  <span className="hidden max-w-[100px] truncate font-medium sm:block">
                    {user.name}
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-xs font-semibold">{user.name}</p>
                  <p className="truncate text-[11px] font-normal text-muted-foreground">
                    {user.email}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard" className="text-xs">
                    <FolderKanban className="mr-2 h-3.5 w-3.5" />
                    Projects
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/runs" className="text-xs">
                    <Terminal className="mr-2 h-3.5 w-3.5" />
                    Runs
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="p-1.5">
                  <SignOutButton />
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1">{children}</main>
      </div>

      {/* ─── Command Palette ─────────────────────────────────────────────── */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b p-4 pb-3">
            <DialogTitle className="text-sm">Quick Navigation</DialogTitle>
            <DialogDescription className="text-xs">
              Jump to any Orqestra module.
            </DialogDescription>
            <div className="relative mt-2">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Type to search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-8 text-xs"
                autoFocus
              />
            </div>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto p-2">
            {filteredItems.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No results.</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filteredItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => {
                        setSearchOpen(false);
                        setMobileOpen(false);
                      }}
                      className="flex items-center gap-2.5 rounded-lg p-2.5 text-xs transition-colors hover:bg-muted"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="font-medium">{item.label}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {item.href.replace("/dashboard", "")}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
