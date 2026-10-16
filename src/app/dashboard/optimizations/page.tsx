import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { History } from "lucide-react";
import {
  OptimizationsView,
  type OptimizationRowDto,
} from "@/components/optimization/optimizations-view";
import { LoopPrinciple } from "@/components/optimization/shared";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { listOptimizationSessions } from "@/modules/optimization/optimization.service";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Optimizations",
};

/**
 * Phase 5's front door: every optimization session the caller may see.
 *
 * The service returns rows built from persisted sessions only — the recommended
 * candidate comes from the stored ranking, and the stopping reason comes from the
 * record the loop wrote when it stopped, so this page can never show an outcome
 * the evidence does not support.
 */
async function OptimizationsData() {
  const user = await getCurrentUser();
  const [projects, page] = await Promise.all([
    listProjects(user),
    listOptimizationSessions(user, { limit: 50 }),
  ]);

  const rows: OptimizationRowDto[] = page.items.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    agentName: item.agentName,
    baselineVersion: item.baselineVersion,
    strategy: item.strategy,
    datasetName: item.datasetName,
    caseCount: item.caseCount,
    candidateCount: item.candidateCount,
    acceptedCount: item.acceptedCount,
    currentIteration: item.currentIteration,
    maxIterations: item.maxIterations,
    bestCandidateLabel: item.bestCandidateLabel,
    stopReason: item.stopReason,
    runCount: item.runCount,
    estimatedCostUsd: item.estimatedCostUsd,
    createdAt: item.createdAt.toISOString(),
    startedAt: item.startedAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Optimizations</h1>
            <p className="text-sm text-muted-foreground">
              Close the measurable weaknesses of a harness with a bounded loop: analyse a real
              evaluation, propose the smallest change, validate it, measure it against the baseline,
              and accept or reject it on deterministic policies. A published version is never
              rewritten.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <Link href="/dashboard/optimizations/history">
              <History className="h-3.5 w-3.5" />
              Cross-session history
            </Link>
          </Button>
        </div>
        <LoopPrinciple />
      </header>

      <OptimizationsView
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        initialOptimizations={rows}
      />
    </main>
  );
}

export default function OptimizationsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading optimizations…
        </main>
      }
    >
      <OptimizationsData />
    </Suspense>
  );
}
