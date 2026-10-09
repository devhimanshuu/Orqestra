import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { RunsView, type RunFilterOption, type RunListRowDto } from "@/components/runs-view";
import { getCurrentUser } from "@/lib/auth/session";
import { logger } from "@/lib/logging/logger";
import { listRuns } from "@/modules/runtime/run.service";
import { listRunsQuerySchema } from "@/modules/runtime/run.inputs";
import { listProjects } from "@/modules/projects/project.service";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { agentRepository } from "@/modules/agents/agent.repository";

export const metadata: Metadata = {
  title: "Runs",
};

/**
 * Run history.
 *
 * Filtering happens in the service (ownership-scoped query) and the page passes
 * serializable rows to the client view, which owns filter state + pagination.
 * Nothing here executes a run: runs are created from the builder or the API.
 */
async function RunsData({ search }: { search: URLSearchParams }) {
  const user = await getCurrentUser();

  const parsed = listRunsQuerySchema.safeParse(Object.fromEntries(search));
  if (!parsed.success) {
    // Unknown filters are ignored rather than failing the page: a stale link
    // should still show the run history.
    logger.warn("invalid run filter", { issues: parsed.error.issues.length });
  }
  const query = parsed.success ? parsed.data : listRunsQuerySchema.parse({});

  const page = await listRuns(user, query);

  const projects = await listProjects(user);
  const [harnessLists, agentLists] = await Promise.all([
    Promise.all(projects.map((project) => harnessRepository.listByProject(project.id))),
    Promise.all(projects.map((project) => agentRepository.listByProject(project.id))),
  ]);
  const harnesses: RunFilterOption[] = harnessLists
    .flat()
    .map((harness) => ({ id: harness.id, name: harness.name }));
  const agents: RunFilterOption[] = agentLists.flat().map((agent) => ({ id: agent.id, name: agent.name }));

  const runs: RunListRowDto[] = page.runs.map((run) => ({
    id: run.id,
    status: run.status,
    harnessId: run.harnessId,
    harnessName: run.harnessName,
    harnessVersionLabel: run.harnessVersionLabel,
    agentId: run.agentId,
    agentName: run.agentName,
    attempt: run.attempt,
    retryOfRunId: run.retryOfRunId,
    inputPreview: run.inputPreview,
    outputPreview: run.outputPreview,
    errorCode: run.errorCode,
    totalTokens: run.totalTokens,
    cost: run.cost,
    costKnown: run.costKnown,
    durationMs: run.durationMs,
    stepCount: run.stepCount,
    createdAt: run.createdAt.toISOString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Runs</span>
      </nav>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted-foreground">
          Every execution of a harness version, with its trace, token usage and cost. History is
          immutable — retrying a run creates a new one.
        </p>
      </header>

      <RunsView
        initialRuns={runs}
        initialTotal={page.total}
        harnesses={harnesses}
        agents={agents}
        {...(query.harnessId !== undefined ? { lockedHarnessId: query.harnessId } : {})}
        {...(query.agentId !== undefined ? { lockedAgentId: query.agentId } : {})}
      />
    </main>
  );
}

export default function RunsPage({ searchParams }: PageProps<"/dashboard/runs">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading runs…
        </main>
      }
    >
      <RunsSearchResolver searchParams={searchParams} />
    </Suspense>
  );
}

async function RunsSearchResolver({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard/runs">["searchParams"];
}) {
  const resolved = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved ?? {})) {
    if (typeof value === "string") {
      search.set(key, value);
    } else if (Array.isArray(value) && value[0] !== undefined) {
      search.set(key, value[0]);
    }
  }
  return <RunsData search={search} />;
}
