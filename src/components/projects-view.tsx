"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  FolderKanban,
  Grid,
  List,
  Network,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  counts: { agents: number; harnesses: number };
}

/**
 * Dashboard project list. Data arrives pre-fetched from the server component;
 * this view handles client-side filtering, view toggling, navigation and project creation.
 */
export function ProjectsView({ projects }: { projects: ProjectDto[] }) {
  const [filterQuery, setFilterQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const filteredProjects = useMemo(() => {
    if (!filterQuery.trim()) return projects;
    const query = filterQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query) ||
        (p.description && p.description.toLowerCase().includes(query)),
    );
  }, [projects, filterQuery]);

  return (
    <div className="flex flex-col gap-6">
      {/*
        Toolbar only. The page header (src/app/dashboard/page.tsx) owns the title
        and description; repeating them here rendered two headings named
        "Projects" on one screen and duplicated the same subtitle verbatim.
      */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono text-xs">
            {projects.length}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {projects.length === 1 ? "project" : "projects"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* View Toggle */}
          <div className="hidden sm:flex items-center rounded-lg border border-border/80 bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                viewMode === "grid"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Grid view"
            >
              <Grid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                viewMode === "list"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          <CreateProjectDialog />
        </div>
      </div>

      {/* Filter and Search Bar */}
      {projects.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter projects by title or slug..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="pl-9 h-9 text-xs bg-card/60"
            />
          </div>
          {filterQuery && (
            <p className="text-xs text-muted-foreground whitespace-nowrap">
              Showing {filteredProjects.length} of {projects.length}
            </p>
          )}
        </div>
      )}

      {/* Empty State */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/20 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-xs">
            <FolderKanban className="h-7 w-7" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">No projects yet</h3>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            A project is the top-level container for your agents, graph harnesses, and versioned runs.
          </p>
          <div className="mt-6">
            <CreateProjectDialog />
          </div>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border/60 bg-muted/20 py-12 text-center">
          <p className="text-sm font-medium text-foreground">No projects match &ldquo;{filterQuery}&rdquo;</p>
          <p className="mt-1 text-xs text-muted-foreground">Try searching with a different keyword</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilterQuery("")}
            className="mt-3 text-xs"
          >
            Clear filter
          </Button>
        </div>
      ) : viewMode === "grid" ? (
        /* Grid View */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2" data-testid="project-list">
          {filteredProjects.map((project) => {
            const initials = project.name
              .split(" ")
              .map((w) => w[0])
              .filter(Boolean)
              .slice(0, 2)
              .join("")
              .toUpperCase();

            return (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}`}
                data-testid={`project-card-${project.slug}`}
                className="group relative flex flex-col justify-between rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 via-primary/5 to-muted font-mono text-xs font-bold text-primary ring-1 ring-primary/20">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-semibold text-foreground group-hover:text-primary transition-colors">
                          {project.name}
                        </h3>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {project.slug}
                        </span>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-normal shrink-0">
                      Active
                    </Badge>
                  </div>

                  {project.description ? (
                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {project.description}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs italic text-muted-foreground/60">
                      No description provided
                    </p>
                  )}
                </div>

                <div className="mt-5 pt-3.5 border-t border-border/50 flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 font-medium text-foreground">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                      {project.counts.agents} {project.counts.agents === 1 ? "agent" : "agents"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 font-medium text-foreground">
                      <Network className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      {project.counts.harnesses}{" "}
                      {project.counts.harnesses === 1 ? "harness" : "harnesses"}
                    </span>
                  </div>

                  <span className="inline-flex items-center gap-1 font-medium text-primary group-hover:translate-x-0.5 transition-transform">
                    <span>Open</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        /* List View */
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs" data-testid="project-list">
          <div className="divide-y divide-border/60">
            {filteredProjects.map((project) => (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}`}
                data-testid={`project-card-${project.slug}`}
                className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary font-mono text-xs font-bold">
                    {project.name[0]}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                        {project.name}
                      </h3>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {project.slug}
                      </span>
                    </div>
                    {project.description && (
                      <p className="truncate text-xs text-muted-foreground mt-0.5">
                        {project.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs shrink-0 self-end sm:self-center">
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Bot className="h-3.5 w-3.5" />
                      {project.counts.agents}
                    </span>
                    <span className="flex items-center gap-1">
                      <Network className="h-3.5 w-3.5" />
                      {project.counts.harnesses}
                    </span>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateProjectDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post("/api/projects", {
        name: name.trim(),
        description: description.trim() ? description.trim() : undefined,
      });
      setOpen(false);
      setName("");
      setDescription("");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="create-project" className="shadow-xs gap-1.5">
          <Plus className="h-4 w-4" />
          <span>New project</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base">Create new project</DialogTitle>
              <DialogDescription className="text-xs">
                A project groups AI agents, behavioral harnesses, and evaluations.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name" className="text-xs font-semibold">
              Project Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="project-name"
              data-testid="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Research Assistant or Evaluation Platform"
              required
              maxLength={80}
              autoFocus
              className="h-9 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description" className="text-xs font-semibold">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="project-description"
              data-testid="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this initiative and what agent behaviours does it test?"
              rows={3}
              maxLength={500}
              className="text-xs resize-none"
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || name.trim() === ""}
              data-testid="project-submit"
            >
              {pending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
