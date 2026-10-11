import { loadEnvFile } from "node:process";
import { hashPassword } from "better-auth/crypto";
import { getEnv, type Env } from "../src/config/env";
import type { AuthUser } from "../src/lib/auth/provider";
import { getPrisma } from "../src/lib/db/prisma";
import { agentRepository } from "../src/modules/agents/agent.repository";
import { datasetRepository } from "../src/modules/evaluation/dataset.repository";
import { evaluatorRepository } from "../src/modules/evaluation/evaluator.repository";
import { hashJson } from "../src/modules/evaluation/hashing";
import { harnessRepository } from "../src/modules/harness/harness.repository";
import type { HarnessDefinition } from "../src/modules/harness/harness.schema";
import { hashHarnessDefinition } from "../src/modules/harness/harness.serialize";
import { ensureLocalUser } from "../src/modules/users/user.service";

/**
 * Seed: a minimal, realistic workspace so a new developer can sign in and see
 * the Phase 1 visual builder working end-to-end.
 *
 * Identity: with hosted Neon Auth (`AUTH_URL` set) the seed acts as the
 * bootstrap for the demo account — sign-in, then sign-up if it does not exist
 * yet — because credentials live in the hosted instance, not in our tables.
 * The resulting identity is mirrored into `public."User"` by ensureLocalUser,
 * exactly as the running app does on first sign-in.
 *
 * Idempotent — running it twice is safe (upserts by natural keys).
 */

const DEMO_SLUG = "demo-workspace";
const DEMO_USER_NAME = "Demo User";

/**
 * Phase 3 demo fixtures: an agent + harness that actually execute (mock
 * provider, one deterministic tool), a tiny dataset and two evaluators — so the
 * run lab has something real to run on a fresh install.
 */
const EVAL_AGENT_NAME = "Evaluation Demo Agent";
const EVAL_HARNESS_SLUG = "evaluation-demo-harness";
const EVAL_DATASET_SLUG = "demo-eval-prompts";

const EVAL_HARNESS: HarnessDefinition = {
  schemaVersion: 2,
  id: "evaluation-demo-harness",
  version: 1,
  name: "Evaluation demo harness",
  description: "START -> TOOL(current_time) -> END (Phase 3 sample).",
  nodes: [
    { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "clock",
      type: "tool",
      label: "Clock",
      config: { toolId: "current_time" },
      position: { x: 320, y: 0 },
    },
    { id: "end", type: "end", label: "End", config: {}, position: { x: 640, y: 0 } },
  ],
  edges: [
    { id: "e-start-clock", source: "start", target: "clock" },
    { id: "e-clock-end", source: "clock", target: "end" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
};

const EVAL_DATASET_CASES = [
  {
    caseKey: "greet-1",
    name: "Greeting",
    input: "Say hello to the evaluator.",
    expectedOutput: null,
    metadata: null,
    tags: ["smoke"],
  },
  {
    caseKey: "greet-2",
    name: "Second greeting",
    input: "Introduce yourself in one sentence.",
    expectedOutput: null,
    metadata: null,
    tags: ["smoke"],
  },
  {
    caseKey: "time-1",
    name: "Uses the clock",
    input: "What time does the tool report?",
    expectedOutput: null,
    metadata: null,
    tags: ["tool"],
  },
];

// ASCII-only text keeps the seed portable across PostgreSQL clusters that are
// not UTF-8 encoded (e.g. some Windows installs default to WIN1252).
//
// Phase 1 demo harness (definition only — execution lands in Phase 2):
//   Start -> Planner -> Search -> Critic -> Verifier -> End
const DEMO_HARNESS: HarnessDefinition = {
  schemaVersion: 2,
  id: "research-harness",
  version: 1,
  name: "Research harness",
  description: "Plan, search, critique and verify before answering (Phase 1 sample).",
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
        instructions:
          "Break the research question into verifiable steps and record them in state.plan.",
        maxSteps: 8,
      },
      position: { x: 320, y: 0 },
    },
    {
      id: "search",
      type: "tool",
      label: "Search",
      config: { toolId: "search" },
      position: { x: 640, y: 0 },
    },
    {
      id: "critic",
      type: "critic",
      label: "Critic",
      config: {
        instructions: "List unsupported claims, missing evidence and open questions.",
        threshold: 0.6,
      },
      position: { x: 960, y: 0 },
    },
    {
      id: "verifier",
      type: "evaluator",
      label: "Verifier",
      config: {
        instructions: "Score grounding of every claim against the collected evidence.",
        metric: "groundedness",
      },
      position: { x: 1280, y: 0 },
    },
    {
      id: "end",
      type: "end",
      label: "End",
      config: {},
      position: { x: 1600, y: 0 },
    },
  ],
  edges: [
    { id: "e-start-planner", source: "start", target: "planner" },
    { id: "e-planner-search", source: "planner", target: "search" },
    { id: "e-search-critic", source: "search", target: "critic" },
    { id: "e-critic-verifier", source: "critic", target: "verifier" },
    { id: "e-verifier-end", source: "verifier", target: "end" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
};

/** Reads `{ user: {...} }` out of a hosted auth response, or null when malformed. */
async function readAuthUser(response: Response): Promise<AuthUser | null> {
  const body = (await response.json().catch(() => null)) as { user?: unknown } | null;
  const user = body?.user;
  if (typeof user !== "object" || user === null) {
    return null;
  }
  const payload = user as Record<string, unknown>;
  if (
    typeof payload.id !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.name !== "string"
  ) {
    return null;
  }
  return {
    id: payload.id,
    email: payload.email,
    name: payload.name,
    emailVerified: payload.emailVerified === true,
    createdAt: payload.createdAt === undefined ? new Date() : new Date(String(payload.createdAt)),
  };
}

/** POSTs to the hosted auth instance the same way the app's proxy does. */
async function callHostedAuth(
  base: string,
  appOrigin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  try {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appOrigin },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  } catch {
    return null;
  }
}

/**
 * Creates (or finds) the demo account on the hosted instance, then returns the
 * identity our domain rows should reference.
 */
async function bootstrapHostedIdentity(env: Env): Promise<AuthUser> {
  const base = env.AUTH_URL.replace(/\/+$/, "");
  const credentials = { email: env.SEED_USER_EMAIL, password: env.SEED_USER_PASSWORD };

  const signIn = await callHostedAuth(base, env.APP_URL, "/sign-in/email", credentials);
  if (signIn !== null && signIn.ok) {
    const user = await readAuthUser(signIn);
    if (user !== null) {
      process.stdout.write(`  auth:      hosted account reused (${user.email})\n`);
      return user;
    }
  }

  const signUp = await callHostedAuth(base, env.APP_URL, "/sign-up/email", {
    ...credentials,
    name: DEMO_USER_NAME,
  });
  if (signUp !== null && signUp.ok) {
    const user = await readAuthUser(signUp);
    if (user !== null) {
      process.stdout.write(`  auth:      hosted account created (${user.email})\n`);
      return user;
    }
  }

  // The account may already exist under a different password: fall back to the
  // hosted user table so the demo data can still be seeded.
  const rows = await getPrisma().$queryRaw<
    Array<{ id: string; email: string; name: string; emailVerified: boolean; createdAt: Date }>
  >`SELECT id, email, name, "emailVerified", "createdAt" FROM neon_auth."user" WHERE email = ${env.SEED_USER_EMAIL} LIMIT 1`;
  const row = rows[0];
  if (row !== undefined) {
    process.stderr.write(
      `  auth:      WARNING — ${env.SEED_USER_EMAIL} exists on the hosted instance but its password differs from SEED_USER_PASSWORD.\n`,
    );
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: row.emailVerified,
      createdAt: new Date(row.createdAt),
    };
  }

  throw new Error(
    [
      "Could not resolve the demo identity on the hosted auth instance.",
      `Tried ${base}/sign-in/email and /sign-up/email.`,
      "Check that AUTH_URL and APP_URL are correct and that APP_URL is a trusted origin for the project,",
      "or create the account once through the app's sign-up page and rerun `pnpm db:seed`.",
    ].join("\n"),
  );
}

/** Self-hosted fallback: create the local credential user (Phase 0 behaviour). */
async function createLocalCredentialUser(env: Env): Promise<AuthUser> {
  const prisma = getPrisma();
  const passwordHash = await hashPassword(env.SEED_USER_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: env.SEED_USER_EMAIL },
    update: {},
    create: {
      id: "seed-user-demo",
      name: DEMO_USER_NAME,
      email: env.SEED_USER_EMAIL,
      emailVerified: true,
    },
  });

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

  process.stdout.write(`  auth:      self-hosted credential user (${user.email})\n`);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

async function main(): Promise<void> {
  // `prisma db seed` loads .env through prisma.config.ts; a direct
  // `tsx prisma/seed.ts` run needs to do it itself.
  try {
    loadEnvFile();
  } catch {
    // No .env file — validation below reports missing variables.
  }

  const env = getEnv();
  const prisma = getPrisma();

  const identity =
    env.AUTH_URL === "" ? await createLocalCredentialUser(env) : await bootstrapHostedIdentity(env);

  // Mirror the auth identity into public."User" — the same call the app makes
  // on first sign-in, so seed data is owned by the account that will log in.
  await ensureLocalUser(identity);

  const workspace = await prisma.workspace.upsert({
    where: { slug: DEMO_SLUG },
    update: {},
    create: { name: "Demo Workspace", slug: DEMO_SLUG },
  });

  await prisma.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: identity.id, workspaceId: workspace.id } },
    update: {},
    create: { userId: identity.id, workspaceId: workspace.id, role: "owner" },
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
      purpose: "Perform structured research using external tools before answering.",
      instructions:
        "You are a research agent. Gather evidence, cite sources, and be explicit about uncertainty.",
      modelConfig: { model: "gemini:gemini-2.0-flash", temperature: 0.2, maxTokens: 2000 },
      capabilities: ["search", "calculator"],
      createdBy: identity.id,
    });
  }

  const harnessRow = await prisma.harness.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: "research-harness" } },
  });
  if (harnessRow === null) {
    const agent = await prisma.agent.findUnique({
      where: { projectId_slug: { projectId: project.id, slug: "research-agent" } },
      select: { id: true },
    });
    await harnessRepository.createWithVersion({
      projectId: project.id,
      ...(agent !== null ? { agentId: agent.id } : {}),
      name: DEMO_HARNESS.name,
      slug: "research-harness",
      description: DEMO_HARNESS.description,
      definition: DEMO_HARNESS,
      contentHash: hashHarnessDefinition(DEMO_HARNESS),
      entryNode: DEMO_HARNESS.entryNode,
      nodeCount: DEMO_HARNESS.nodes.length,
      edgeCount: DEMO_HARNESS.edges.length,
      status: "VALID",
      createdBy: identity.id,
    });
  }

  // --- Phase 3 demo fixtures (run lab) --------------------------------------
  //
  // These are *executable*: the mock provider needs no API key and the clock
  // tool is deterministic, so a fresh install can run an evaluation immediately.
  const evalAgentRow = await prisma.agent.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: "evaluation-demo-agent" } },
  });
  if (evalAgentRow === null) {
    await agentRepository.createWithVersion({
      projectId: project.id,
      name: EVAL_AGENT_NAME,
      slug: "evaluation-demo-agent",
      description: "A deterministic agent for trying the evaluation run lab.",
      purpose: "Answer short prompts; the harness provides the clock tool.",
      instructions: "Answer the task in one sentence. State the tool result when asked.",
      modelConfig: { model: "mock:deterministic", temperature: 0 },
      capabilities: ["current_time"],
      createdBy: identity.id,
    });
  }

  const evalHarnessRow = await prisma.harness.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: EVAL_HARNESS_SLUG } },
  });
  if (evalHarnessRow === null) {
    const evalAgent = await prisma.agent.findUnique({
      where: { projectId_slug: { projectId: project.id, slug: "evaluation-demo-agent" } },
      select: { id: true },
    });
    await harnessRepository.createWithVersion({
      projectId: project.id,
      ...(evalAgent !== null ? { agentId: evalAgent.id } : {}),
      name: EVAL_HARNESS.name,
      slug: EVAL_HARNESS_SLUG,
      description: EVAL_HARNESS.description,
      definition: EVAL_HARNESS,
      contentHash: hashHarnessDefinition(EVAL_HARNESS),
      entryNode: EVAL_HARNESS.entryNode,
      nodeCount: EVAL_HARNESS.nodes.length,
      edgeCount: EVAL_HARNESS.edges.length,
      status: "VALID",
      createdBy: identity.id,
    });
  }

  const evalDatasetRow = await prisma.dataset.findUnique({
    where: { projectId_slug: { projectId: project.id, slug: EVAL_DATASET_SLUG } },
  });
  if (evalDatasetRow === null) {
    const dataset = await datasetRepository.create({
      projectId: project.id,
      name: "Demo evaluation prompts",
      slug: EVAL_DATASET_SLUG,
      description: "Three short prompts for the Phase 3 run lab.",
      cases: EVAL_DATASET_CASES,
    });
    await datasetRepository.publishVersion({
      datasetId: dataset.id,
      version: 1,
      name: "Initial version",
      cases: EVAL_DATASET_CASES,
      contentHash: hashJson(EVAL_DATASET_CASES),
      createdBy: identity.id,
    });
  }

  const evalEvaluators: Array<{
    slug: string;
    name: string;
    description: string;
    kind: string;
    config: Record<string, unknown>;
  }> = [
    {
      slug: "used-a-tool",
      name: "Used a tool",
      description: "Every case must invoke the current_time tool at least once.",
      kind: "tool_usage",
      config: { required: ["current_time"], minCalls: { current_time: 1 }, maxCalls: { current_time: 3 } },
    },
    {
      slug: "has-output",
      name: "Produced an output",
      description: "The run must finish successfully before this check counts.",
      kind: "harness_compliance",
      config: { requiredNodes: ["start", "clock", "end"], requireSucceededRun: true },
    },
  ];
  for (const entry of evalEvaluators) {
    const existingEvaluator = await prisma.evaluator.findUnique({
      where: { projectId_slug: { projectId: project.id, slug: entry.slug } },
    });
    if (existingEvaluator === null) {
      await evaluatorRepository.createWithVersion({
        projectId: project.id,
        name: entry.name,
        slug: entry.slug,
        description: entry.description,
        kind: entry.kind,
        config: entry.config,
        weight: 0,
        contentHash: hashJson({ kind: entry.kind, config: entry.config, weight: 0 }),
        createdBy: identity.id,
      });
    }
  }

  process.stdout.write(
    [
      "Seed complete:",
      `  user:      ${identity.email} (password: ${env.SEED_USER_PASSWORD})`,
      `  workspace: ${workspace.slug}`,
      `  project:   ${project.slug}`,
      "  agent:     research-agent (v1)",
      "  harness:   research-harness (v1, 6 nodes)",
      `  run lab:   evaluation-demo-agent / ${EVAL_HARNESS_SLUG} (v1, 3 nodes)`,
      `  dataset:   ${EVAL_DATASET_SLUG} (v1, ${EVAL_DATASET_CASES.length} cases)`,
      "  evaluators: used-a-tool, has-output",
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
