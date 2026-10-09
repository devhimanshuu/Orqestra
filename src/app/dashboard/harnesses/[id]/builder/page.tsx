import type { Metadata } from "next";
import { Suspense } from "react";
import { BuilderShell, type BuilderPayload } from "@/components/builder/builder-shell";
import { getCurrentUser } from "@/lib/auth/session";
import { getHarnessDetail } from "@/modules/harness/harness.service";
import { requireProject } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Harness Builder",
};

/**
 * Full-screen visual builder. The server resolves the harness (ownership checked
 * in the service layer) and passes only serializable data to the client shell.
 */
async function BuilderData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const detail = await getHarnessDetail(user, id);
  const project = await requireProject(detail.harness.projectId);

  const payload: BuilderPayload = {
    harness: {
      id: detail.harness.id,
      agentId: detail.harness.agentId,
      name: detail.harness.name,
      slug: detail.harness.slug,
      description: detail.harness.description,
      status: detail.harness.status,
      currentVersion: detail.harness.currentVersion,
    },
    currentDefinition: detail.currentDefinition,
    validation: detail.validation,
    agent: detail.agent,
    projectName: project.name,
    projectId: project.id,
  };

  return <BuilderShell payload={payload} />;
}

export default function HarnessBuilderPage({
  params,
}: PageProps<"/dashboard/harnesses/[id]/builder">) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
          Loading builder…
        </div>
      }
    >
      <BuilderIdResolver params={params} />
    </Suspense>
  );
}

async function BuilderIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/harnesses/[id]/builder">["params"];
}) {
  const { id } = await params;
  return <BuilderData id={id} />;
}
