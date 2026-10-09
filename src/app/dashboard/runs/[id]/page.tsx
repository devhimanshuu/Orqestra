import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { RunDetailView, type RunDetailDto, type RunStepDto, type RunUsageDto } from "@/components/run-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { getRunDetail } from "@/modules/runtime/run.service";

export const metadata: Metadata = {
  title: "Run",
};

/**
 * Run detail page.
 *
 * The server resolves and authorizes the run (user → workspace → project →
 * harness → run); the client view owns live updates, cancellation and retry.
 */
async function RunData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const detail = await getRunDetail(user, id);

  const run: RunDetailDto = {
    id: detail.run.id,
    status: detail.run.status,
    attempt: detail.run.attempt,
    retryOfRunId: detail.run.retryOfRunId,
    input: detail.run.input,
    output: detail.run.output,
    error: detail.run.error,
    createdAt: detail.run.createdAt.toISOString(),
    startedAt: detail.run.startedAt?.toISOString() ?? null,
    completedAt: detail.run.completedAt?.toISOString() ?? null,
    latencyMs: detail.run.latencyMs,
    cancelRequestedAt: detail.run.cancelRequestedAt?.toISOString() ?? null,
    metadata: detail.run.metadata,
    harnessId: detail.run.harnessId,
    harnessVersionId: detail.run.harnessVersionId,
    agentId: detail.run.agentId,
  };

  const steps: RunStepDto[] = detail.steps.map((step) => ({
    id: step.id,
    index: step.index,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    nodeLabel: step.nodeLabel,
    status: step.status,
    input: step.input,
    output: step.output,
    error: step.error,
    metadata: step.metadata,
    iteration: step.iteration,
    startedAt: step.startedAt?.toISOString() ?? null,
    completedAt: step.completedAt?.toISOString() ?? null,
    durationMs: step.durationMs,
  }));

  const usage: RunUsageDto[] = detail.usage.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd,
  }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link href="/dashboard/runs" className="hover:text-foreground">
          Runs
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono font-medium text-foreground">#{id.slice(-6)}</span>
      </nav>

      <RunDetailView
        runId={id}
        initial={{
          run,
          steps,
          usage,
          usageTotal: detail.usageTotal,
          harness: detail.harness,
          harnessVersionLabel: detail.harnessVersionLabel,
          agent: detail.agent,
          live: detail.live,
        }}
      />
    </main>
  );
}

export default function RunDetailPage({ params }: PageProps<"/dashboard/runs/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading run…
        </main>
      }
    >
      <RunIdResolver params={params} />
    </Suspense>
  );
}

async function RunIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/runs/[id]">["params"];
}) {
  const { id } = await params;
  return <RunData id={id} />;
}
