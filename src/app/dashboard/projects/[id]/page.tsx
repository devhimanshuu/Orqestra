import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import {
  ProjectDetailView,
  type AgentSummaryDto,
  type HarnessSummaryDto,
} from "@/components/project-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { getProjectDetail } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Project",
};

async function ProjectData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const detail = await getProjectDetail(user, id);

  const agents: AgentSummaryDto[] = detail.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    description: agent.description,
    purpose: agent.purpose,
    currentVersion: agent.currentVersion,
    modelConfig: agent.modelConfig,
    harnessCount: agent.harnessCount,
  }));

  const harnesses: HarnessSummaryDto[] = detail.harnesses.map((harness) => ({
    id: harness.id,
    name: harness.name,
    slug: harness.slug,
    agentId: harness.agentId,
    status: harness.status,
    currentVersion: harness.currentVersion,
    nodeCount: harness.nodeCount,
    edgeCount: harness.edgeCount,
  }));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{detail.project.name}</span>
      </nav>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{detail.project.name}</h1>
        <p className="text-sm text-muted-foreground">
          {detail.project.description ?? "No description yet."}
        </p>
      </header>

      <ProjectDetailView projectId={detail.project.id} agents={agents} harnesses={harnesses} />
    </main>
  );
}

export default function ProjectDetailPage({ params }: PageProps<"/dashboard/projects/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted-foreground">
          Loading project…
        </main>
      }
    >
      <ProjectIdResolver params={params} />
    </Suspense>
  );
}

async function ProjectIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/projects/[id]">["params"];
}) {
  const { id } = await params;
  return <ProjectData id={id} />;
}
