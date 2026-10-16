import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import {
  OptimizationDetailView,
  type OptimizationDetailJson,
} from "@/components/optimization/optimization-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveOrNotFound } from "@/lib/not-found";
import { getOptimizationSession } from "@/modules/optimization/optimization.service";

export const metadata: Metadata = {
  title: "Optimization",
};

/**
 * Optimization detail.
 *
 * The server resolves the session through the workspace → project chain and
 * hands the *serialized* record to the client view, which polls while the loop is
 * active. Nothing on this page executes: every action is an explicit, attributed
 * call the server re-authorizes.
 */
async function OptimizationData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const detail = await resolveOrNotFound(() => getOptimizationSession(user, id));
  // Dates are not valid RSC props; the JSON round trip converts them to ISO
  // strings, which is also exactly what the API returns for a poll.
  const json = JSON.parse(JSON.stringify(detail)) as OptimizationDetailJson;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/optimizations" className="hover:text-foreground">
          Optimizations
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono font-medium text-foreground">#{id.slice(-6)}</span>
      </nav>

      <OptimizationDetailView initial={json} />
    </main>
  );
}

export default function OptimizationDetailPage({
  params,
}: PageProps<"/dashboard/optimizations/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading optimization…
        </main>
      }
    >
      <OptimizationIdResolver params={params} />
    </Suspense>
  );
}

async function OptimizationIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/optimizations/[id]">["params"];
}) {
  const { id } = await params;
  return <OptimizationData id={id} />;
}
