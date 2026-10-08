import { hashPassword } from "better-auth/crypto";
import { getEnv } from "../src/config/env";
import { getPrisma } from "../src/lib/db/prisma";
import { agentRepository } from "../src/modules/agents/agent.repository";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";

/**
 * Seed: a minimal, realistic workspace so a new developer can sign in and see
 * the Phase 1 visual builder working end-to-end.
 *
 * Idempotent — running it twice is safe (upserts by natural keys).
 */

const DEMO_SLUG = "demo-workspace";

// ASCII-only text keeps the seed portable across PostgreSQL clusters that are
// not UTF-8 encoded (e.g. some Windows installs default to WIN1252).
const DEMO_HARNESS: HarnessDefinition = {
  schemaVersion: 2,
  id: "research-harness",
  version: 1,
  name: "Research harness",
  description: "Start -> Planner -> Search -> Critic -> Transform -> End (Phase 1 sample).",
  nodes: [
    {
      id: "start",
      type: "start",
      label: "Start",
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "planner",
      type: "planner",
      label: "Planner",
      config: {
        instructions: "Break the task into verifiable steps and record them in state.plan.",
        maxSteps: 8,
      },
      position: { x: 300, y: 0 },
    },
    {
      id: "search",
      type: "tool",
      label: "Search",
      config: { toolId: "calculator" },
      position: { x: 600, y: 0 },
    },
    {
      id: "critic",
      type: "critic",
      label: "Critic",
      config: {
        instructions: "Review the evidence, list weaknesses, and score confidence 0..1.",
        threshold: 0.6,
      },
      position: { x: 900, y: 0 },
    },
    {
      id: "final",
      type: "transform",
      label: "Final response",
      config: { expression: "state.draftResponse" },
      position: { x: 1200, y: 0 },
    },
    {
      id: "end",
      type: "end",
      label: "End",
      config: {},
      position: { x: 1500, y: 0 },
    },
  ],
  edges: [
    { id: "e-start-planner", source: "start", target: "planner" },
    { id: "e-planner-search", source: "planner", target: "search" },
    { id: "e-search-critic", source: "search", target: "critic" },
    { id: "e-critic-final", source: "critic", target: "final" },
    { id: "e-final-end", source: "final", target: "end" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
};

async function main(): Promise<void> {
  const env = getEnv();
  const prisma = getPrisma();

  const passwordHash = await hashPassword(env.SEED_USER_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: env.SEED_USER_EMAIL },
    update: {},
    create: {
      id: "seed-user-demo",
      name: "Demo User",
      email: env.SEED_USER_EMAIL,
      emailVerified: true,
    },
  });

  // Credential account row — identical shape to what Better Auth writes on sign-up.
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (existingAccount === null) {
    await prisma.account.create({
      data: {
        id: "seed-account-demo",
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
      },
    });
  }

  const workspace = await prisma.workspace.upsert({
    where: { slug: DEMO_SLUG },
    update: {},
    create: { name: "Demo Workspace", slug: DEMO_SLUG },
  });

  await prisma.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    update: {},
    create: { userId: user.id, workspaceId: workspace.id, role: "owner" },
  });

  const project = await prisma.project.upsert({
    where: { workspaceId_slug: { workspaceId: workspace.id, slug: "demo-project" } },
    update: {},
    create: {
      workspaceId: workspace.id,
      name: "Demo Project",
      slug: "demo-project",
      description: "Sample project created by `pnpm db:seed`.",
    },
  });

  const agentRow = await prisma.agent.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: "research-agent" } },
  });
  if (agentRow === null) {
    await agentRepository.createWithVersion({
      projectId: project.id,
      name: "Research Agent",
      slug: "research-agent",
      description: "Answers research questions with evidence and critique.",
      instructions:
        "You are a research agent. Gather evidence, cite sources, and be explicit about uncertainty.",
      modelConfig: { model: "gemini:gemini-2.0-flash", temperature: 0.2 },
      capabilities: ["calculator"],
      createdBy: user.id,
    });
  }

  const harnessRow = await prisma.harness.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: "research-harness" } },
  });
  if (harnessRow === null) {
    await harnessRepository.createWithVersion({
      projectId: project.id,
      name: DEMO_HARNESS.name,
      slug: "research-harness",
      description: DEMO_HARNESS.description,
      definition: DEMO_HARNESS,
      contentHash: hashHarnessDefinition(DEMO_HARNESS),
      entryNode: DEMO_HARNESS.entryNode,
      nodeCount: DEMO_HARNESS.nodes.length,
      edgeCount: DEMO_HARNESS.edges.length,
      status: "VALID",
      createdBy: user.id,
    });
  }

  process.stdout.write(
    [
      "Seed complete:",
      `  user:      ${env.SEED_USER_EMAIL} (password: ${env.SEED_USER_PASSWORD})`,
      `  workspace: ${workspace.slug}`,
      `  project:   ${project.slug}`,
      "  agent:     research-agent (v1)",
      "  harness:   research-harness (v1, 6 nodes)",
      "",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void getPrisma().$disconnect();
  });
