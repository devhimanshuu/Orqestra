import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { AgentOverviewView, type AgentOverviewDto } from "@/components/agent-overview-view";
import { getCurrentUser } from "@/lib/auth/session";
import { getAgentOverview } from "@/modules/agents/agent.service";
import { requireProject } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Agent",
};

async function AgentData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const overview = await getAgentOverview(user, id);
  const project = await requireProject(overview.projectId);

  const agent: AgentOverviewDto = {
    id: overview.id,
    projectId: overview.projectId,
    name: overview.name,
    slug: overview.slug,
    description: overview.description,
    currentVersion: overview.currentVersion,
    latestVersion: {
      version: overview.latestVersion.version,
      purpose: overview.latestVersion.purpose,
      instructions: overview.latestVersion.instructions,
      modelConfig: overview.latestVersion.modelConfig,
    },
    harnesses: overview.harnesses,
    runCount: overview.runCount,
    versionCount: overview.versionCount,
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link href={`/dashboard/projects/${project.id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{overview.name}</span>
      </nav>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{overview.name}</h1>
      </header>

      <AgentOverviewView agent={agent} />
    </main>
  );
}

export default function AgentOverviewPage({ params }: PageProps<"/dashboard/agents/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted-foreground">
          Loading agent…
        </main>
      }
    >
      <AgentIdResolver params={params} />
    </Suspense>
  );
}

async function AgentIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/agents/[id]">["params"];
}) {
  const { id } = await params;
  return <AgentData id={id} />;
}
