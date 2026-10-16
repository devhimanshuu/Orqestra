import type { Metadata } from "next";
import { Suspense } from "react";
import { EvaluatorsView, type EvaluatorRowDto } from "@/components/evaluation/evaluators-view";
import { getCurrentUser } from "@/lib/auth/session";
import { listEvaluators, listKinds } from "@/modules/evaluation/evaluator.service";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Evaluators",
};

/**
 * Evaluators: the reusable scoring procedures a batch pins by revision.
 *
 * The available kinds (with their config fields, defaults and descriptions) come
 * from the registry, so the create form is driven by the server's own contract.
 */
async function EvaluatorsData() {
  const user = await getCurrentUser();
  const [projects, evaluators] = await Promise.all([
    listProjects(user),
    listEvaluators(user, { enabledOnly: false }),
  ]);

  const rows: EvaluatorRowDto[] = evaluators.map((entry) => ({
    id: entry.id,
    projectId: entry.projectId,
    name: entry.name,
    slug: entry.slug,
    description: entry.description,
    kind: entry.kind,
    enabled: entry.enabled,
    currentVersion: entry.currentVersion,
    versionCount: entry.versionCount,
    weight: entry.current.weight,
    updatedAt: entry.updatedAt.toISOString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Evaluators</h1>
        <p className="text-sm text-muted-foreground">
          Deterministic checks (exact match, contains, JSON schema, tool usage, workflow compliance)
          and LLM judges, each validated against its own strict configuration schema. Changing a
          configuration publishes a new revision.
        </p>
      </header>

      <EvaluatorsView
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        initialEvaluators={rows}
        kinds={listKinds()}
      />
    </main>
  );
}

export default function EvaluatorsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading evaluators…
        </main>
      }
    >
      <EvaluatorsData />
    </Suspense>
  );
}
