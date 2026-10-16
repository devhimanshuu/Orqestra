import type { Metadata } from "next";
import { Suspense } from "react";
import { HistoryView } from "@/components/optimization/history-view";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentUser } from "@/lib/auth/session";
import { optimizationHistoryQuerySchema } from "@/modules/optimization/optimization.inputs";
import { getOptimizationHistory } from "@/modules/optimization/optimization.service";

export const metadata: Metadata = {
  title: "Optimization history",
};

/**
 * Cross-session optimization history.
 *
 * Answers what a single session cannot: across every session in scope, how does
 * each mutation strategy perform, per weakness? The scope is validated with the
 * same Zod schema the API uses, so a hand-edited URL cannot widen it, and the
 * service re-checks project/agent membership regardless.
 */
async function HistoryData({
  projectId,
  agentId,
  since,
}: {
  projectId: string | null;
  agentId: string | null;
  since: string | null;
}) {
  const user = await getCurrentUser();
  const parsed = optimizationHistoryQuerySchema.safeParse({
    ...(projectId === null ? {} : { projectId }),
    ...(agentId === null ? {} : { agentId }),
    ...(since === null ? {} : { since }),
  });
  // An unparseable scope is ignored rather than failing the page: a stale link
  // should still show the workspace's history.
  const query = parsed.success ? parsed.data : {};
  const history = await getOptimizationHistory(user, query);

  return <HistoryView history={history} />;
}

export default function OptimizationHistoryPage({
  searchParams,
}: PageProps<"/dashboard/optimizations/history">) {
  return (
    <Suspense fallback={<HistoryLoading />}>
      <SearchParamsResolver searchParams={searchParams} />
    </Suspense>
  );
}

async function SearchParamsResolver({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard/optimizations/history">["searchParams"];
}) {
  const resolved = await searchParams;
  const projectId = typeof resolved.projectId === "string" ? resolved.projectId : null;
  const agentId = typeof resolved.agentId === "string" ? resolved.agentId : null;
  const since = typeof resolved.since === "string" ? resolved.since : null;
  return <HistoryData projectId={projectId} agentId={agentId} since={since} />;
}

function HistoryLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
