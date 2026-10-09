# Orqestra

**Engineer, execute, evaluate, and eventually evolve AI-agent harnesses.**

Orqestra is not another agent builder. The LLM is one component; the _harness_ —
the way an agent reasons, uses tools, manages context and memory, loops, recovers
from failures, and terminates — is the product.

> **Current status: Phase 1 — Agent & Visual Harness Builder.**
> Projects, agents, harnesses, the React Flow builder (node library, inspector,
> graph validation), draft autosave, immutable versions, and JSON import/export
> are in place. Execution, tracing, and evaluation land in later phases (see
> [Roadmap](#roadmap)). Agent execution is deliberately _not_ wired up yet: the
> UI never pretends to run a harness.

---

## 1. What Orqestra is

A platform where a developer can:

1. define an **agent** (identity, purpose, instructions, model, capabilities),
2. visually engineer the **harness** that controls its behavior,
3. execute it and inspect every step,
4. **evaluate** the result,
5. compare harness versions and run **experiments**,
6. and eventually let the harness **evolve** from evaluation results.

The long-term pipeline the architecture is built around:

```text
Agent
   ↓
Harness Definition
   ↓
Harness Compiler
   ↓
Execution Plan
   ↓
Agent Runtime
   ↓
Tools / Memory / Context / Loops
   ↓
LLM
   ↓
Evaluation
   ↓
Trace
   ↓
Experiment
   ↓
Harness Optimization
   ↓
New Harness
```

## 2. Core concept: Agent vs Harness

This distinction is the heart of Orqestra and is enforced in the code layout,
the database schema, and the type system.

|                     | **Agent**                                                              | **Harness**                                                                                              |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Question it answers | _Who is this agent?_                                                   | _How does it behave?_                                                                                    |
| Contains            | identity, purpose, goal, base instructions, model config, capabilities | reasoning flow, tool use, memory, context construction, loops, failure handling, evaluation, termination |
| Example             | `Research Agent`                                                       | `Planner → Search → Critic → Final`                                                                      |
| Storage             | `Agent` + immutable `AgentVersion` rows                                | `Harness` + immutable `HarnessVersion` rows                                                              |

They are never merged into one object. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full treatment (and for
Runtime / Tool / Run / Evaluation / Experiment).

## 3. Architecture at a glance

```text
src/
├── app/                  # Next.js App Router: pages + route handlers (thin)
│   ├── api/health/       #   GET /api/health → health service
│   ├── api/auth/[...all] #   delegated to the AuthProvider abstraction
│   ├── dashboard/        #   Phase 0 developer shell
│   └── login/
├── components/           # UI only — no business logic, no direct DB/LLM access
│   └── ui/               #   shadcn/ui primitives
├── modules/              # domain logic, framework-free
│   ├── agents/           #   Agent / AgentVersion
│   ├── harness/          #   DSL, validation, versioning, editor store
│   ├── runtime/          #   compiler → executor → events → trace; runs, queues, worker
│   ├── tools/            #   tool interface + registry + example tool
│   ├── llm/              #   gateway + Gemini / Ollama adapters
│   ├── evaluation/       #   concepts only (Phase 4)
│   ├── experiments/      #   concepts only (Phase 5–6)
│   └── memory/           #   reserved (Phase 7)
├── lib/                  # infrastructure: db, redis, auth, logging, health, http
├── config/               # environment schema + validation
└── types/                # DTOs shared between server and client
```

**Dependency rule:** `app` → `modules`/`lib` → `config`/`types`. Domain modules
never import from `app`, `components`, or React. Route handlers validate input and
delegate; they contain no business logic.

Request flow for anything non-trivial:

```text
Request → validation → service → domain logic → repository / queue → response
```

## 4. Tech stack

| Concern       | Choice                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Framework     | Next.js 16 (App Router, Cache Components), React 19, TypeScript (strict)                                                       |
| Styling / UI  | Tailwind CSS v4, shadcn/ui primitives                                                                                          |
| Visual graph  | `@xyflow/react` (React Flow) — the builder canvas                                                                              |
| Client state  | Zustand (editor drafts), TanStack Query (server state)                                                                         |
| Database      | PostgreSQL + Prisma 7 (`prisma-client` generator, `@prisma/adapter-neon`)                                                      |
| Queue         | Redis + BullMQ (runs never execute inside a request)                                                                           |
| Auth          | Neon Auth (hosted Better Auth) behind an `AuthProvider` abstraction; self-hosted Better Auth fallback when `AUTH_URL` is unset |
| Validation    | Zod (env, harness DSL, tool input, queue payloads)                                                                             |
| Logging       | Structured JSON logger (no scattered `console.log`)                                                                            |
| Tests         | Vitest (unit), Playwright (e2e: auth + the full builder flow)                                                                  |
| Lint / format | ESLint (flat config, `eslint-config-next` + Prettier)                                                                          |
| LLM providers | Gateway + Gemini and Ollama adapters (Groq/OpenAI/Anthropic keys reserved)                                                     |

## 5. Local setup

Prerequisites: **Node.js ≥ 20.9**, **pnpm 10**, **PostgreSQL**, **Redis**.
Use `docker compose up -d` for a local PostgreSQL + Redis, or point
`DATABASE_URL` at a Neon database instead.

### Authentication

Orqestra authenticates against **Neon Auth** — Better Auth hosted by Neon on the
project's database. Take `AUTH_URL` and `JWKS_URL` from the Neon console (the URL
looks like `https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth`) and
keep `APP_URL` equal to the origin registered as trusted on that instance: the
app's `/api/auth/*` proxy validates the browser origin itself and forwards
`APP_URL` upstream, because the hosted instance cannot know about dev ports.

With `AUTH_URL` unset the app falls back to **self-hosted Better Auth** against
the local database — useful for offline work; `pnpm db:seed` then creates the
credential row itself.

```bash
# 1. install dependencies
pnpm install

# 2. create your environment file
cp .env.example .env
#    set DATABASE_URL, REDIS_URL, AUTH_URL, JWKS_URL and a real secret:
#    openssl rand -base64 48

# 3. create the schema (applies migrations AND generates the Prisma client into
#    src/generated/prisma, which type-checking and the build require)
pnpm db:migrate

# 4. seed the demo workspace. With AUTH_URL set this also bootstraps the demo
#    account on the hosted instance (sign-in first, then sign-up), because the
#    credentials live there — the app mirrors the identity into public."User".
pnpm db:seed

# 5. run the app
pnpm dev            # http://localhost:3000
```

Sign in with the seeded demo account (development only — see `.env.example`):

```text
email:    demo@orqestra.dev
password: orqestra-demo-password
```

The dashboard shows live health for the application, environment, PostgreSQL, and
Redis. `GET /api/health` returns the same information as JSON (`200` when healthy,
`503` when degraded).

### The Phase 1 loop

The product flow is: **Dashboard → Project → Agent → Harness → Builder**. In the
builder you drag nodes from the library (click also works — nodes are placed in
free slots), wire them together, configure each node in the inspector, validate,
and publish immutable versions while the draft autosaves. `v1` is always a valid
Start → End graph, so a new harness opens in a working state.

### The Phase 2 loop

Open a published harness in the builder → **▶ Run** → give it a task. The dialog
shows the compiler's verdict first (valid, start node, reachability, config) and a
simple execution estimate (nodes, model calls, tool calls) before anything runs.

The request only creates a run and hands it to the dispatcher:

```text
POST /api/runs            → verify ownership → create run (QUEUED) → dispatch
GET  /api/runs            → run history (status / harness / agent / date filters)
GET  /api/runs/:id        → run + steps + events + usage (ownership scoped)
GET  /api/runs/:id/events → Server-Sent Events: run/node/LLM/tool lifecycle
POST /api/runs/:id/cancel → cancellation signal the worker actually observes
POST /api/runs/:id/retry  → creates a *new* run pinned to the same version
```

The worker (or the inline dispatcher) loads the pinned harness version, compiles
it into an execution plan, runs the state machine, and persists every node as a
`RunStep` (with its trace document), the event stream, and usage/cost per
provider+model. Runs are immutable once finished: retrying creates a new run that
points back at its predecessor, and every run stores the pins needed to explain it
later (engine version, harness content hash, model/provider, limits, transport).

## 6. Environment variables

The environment is validated with Zod at startup (and inside `/api/health`).
A missing or malformed _required_ variable makes the server refuse to start with
an explicit list of problems — values are never echoed into logs.

| Variable                                              | Class                               | Notes                                                                                                           |
| ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | **required**                        | `postgresql://…`; must match `docker compose`                                                                   |
| `REDIS_URL`                                           | **required**                        | `redis://…`                                                                                                     |
| `BETTER_AUTH_SECRET`                                  | **required**, production-only value | ≥ 32 chars; rotate per environment                                                                              |
| `AUTH_URL`                                            | optional, provider-specific         | Neon Auth instance URL. When set, `/api/auth/*` is proxied there and sessions resolve against it                |
| `JWKS_URL`                                            | optional, provider-specific         | Neon Auth JWKS endpoint (validated at startup, reserved for stateless token verification)                       |
| `APP_URL`                                             | optional                            | Public base URL **and** the origin presented to hosted auth; must be a trusted origin on the Neon Auth instance |
| `BETTER_AUTH_TRUSTED_ORIGINS`                         | optional                            | Comma-separated extra origins (wildcards allowed). Development additionally trusts any localhost/127.0.0.1 port |
| `LOG_LEVEL`                                           | optional                            | `debug` \| `info` \| `warn` \| `error` (default `info`)                                                         |
| `RUN_EXECUTION_MODE`                                  | optional                            | `auto` (queue when Redis answers, else inline) \| `queue` \| `inline` (default `auto`)                          |
| `RUNTIME_MAX_DURATION_MS`                             | optional                            | Wall-clock ceiling for one run (default `120000`)                                                               |
| `RUNTIME_MAX_NODES`                                   | optional                            | Hard platform ceiling on executed nodes per run (default `100`)                                                 |
| `RUNTIME_MAX_ITERATIONS`                              | optional                            | Hard platform ceiling on loop iterations (default `10`)                                                         |
| `RUNTIME_MAX_LLM_CALLS`                               | optional                            | Hard platform ceiling on provider calls per run (default `30`)                                                  |
| `RUNTIME_MAX_TOOL_CALLS`                              | optional                            | Hard platform ceiling on tool calls per run (default `20`)                                                      |
| `GEMINI_API_KEY`                                      | optional, provider-specific         | Enables the Gemini adapter; absence is reported, not fatal                                                      |
| `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | optional, provider-specific         | Reserved for future adapters                                                                                    |
| `OLLAMA_BASE_URL`                                     | optional, provider-specific         | Local Ollama server (default `http://localhost:11434`)                                                          |
| `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`               | development-only                    | Used by `pnpm db:seed`                                                                                          |

`.env` is git-ignored; `.env.example` is the tracked template. Never commit secrets.

## 7. Running the project

| Command       | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| `pnpm dev`    | Next.js dev server (`http://localhost:3000`)         |
| `pnpm build`  | Production build (compiles, type-checks, prerenders) |
| `pnpm start`  | Serve the production build                           |
| `pnpm icons`  | Regenerate the brand icons from the mark geometry    |
| `pnpm worker` | BullMQ worker for the `orqestra.runs` queue          |

The worker is a separate process by design: long-running agent work must never run
inside an HTTP request. It consumes the `orqestra.runs` queue and executes each run
through the runtime — load version → compile → execute → persist trace, usage and
status. `RUN_EXECUTION_MODE=auto` (the default) enqueues through BullMQ when Redis
answers and otherwise executes in-process, so the runtime works on a laptop without
Redis and in a multi-process deployment with it.

The runtime itself is a domain engine, not a route handler:

```text
Harness definition → validator → compiler → execution plan
                   → runtime (state machine) → node executors → LLM / tools / context
                   → runtime events → trace → Run
```

## 8. Testing

```bash
pnpm test        # Vitest unit tests (harness DSL, env validation, gateway, tools, compiler)
pnpm test:e2e    # Playwright smoke + auth integration tests
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm verify      # lint + typecheck + unit tests + production build
```

- **Unit tests** cover the pure logic: harness schema/validation, canonical
  serialization and content hashing, environment validation, LLM request/response
  translation, tool registry behaviour, the harness compiler, the execution engine
  (node executors, expression resolver, condition evaluator, loop/iteration guards,
  retry + limits policies), and dispatcher transport selection.
- **Runtime verification** (`pnpm exec tsx scripts/verify-phase2.ts`) executes a real
  harness against the real database through the production path — happy path,
  invalid tool, max iterations, retry, cancellation, worker job processing,
  duplicate delivery and cancellation of a running run — and prints a check report.
- **E2E tests** run against a production build (Playwright starts
  `next build && next start` on port 3100) and require the database to be running,
  migrated, and seeded (`playwright.config.ts` loads `.env`, so tests use the same
  auth provider and credentials as the app). Coverage:
  - Phase 0 smoke: app loads, login form renders, `/api/health` report, redirects;
  - authentication: the seeded user signs in through the hosted provider;
  - **Phase 1 full flow**: create project → agent → harness → build the graph
    (add, connect, configure) → validate → autosave → publish v2 → reload and
    confirm the graph persists and v1 is untouched;
  - **Phase 1 round trip**: export JSON → import it → duplicate the harness, and
    confirm every copy keeps the same nodes and edges;
  - **Phase 2 run UI**: run history with filters, the run detail timeline (steps,
    expandable trace, usage, reproducibility pins), state-appropriate controls
    (cancel vs retry), and the builder's Run dialog with its execution preview.
- First run only: `pnpm exec playwright install chromium`.

## 9. Project structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module responsibilities and the
extension points for later phases. Key entry points:

- Harness DSL & rules: [`src/modules/harness/harness.schema.ts`](src/modules/harness/harness.schema.ts),
  [`harness.validation.ts`](src/modules/harness/harness.validation.ts),
  [`harness.serialize.ts`](src/modules/harness/harness.serialize.ts)
- Harness and agent versioning services: [`harness.service.ts`](src/modules/harness/harness.service.ts),
  [`agent.service.ts`](src/modules/agents/agent.service.ts)
- Runtime: [`runtime.ts`](src/modules/runtime/runtime.ts),
  [`compiler.ts`](src/modules/runtime/compiler.ts),
  [`executor/engine.ts`](src/modules/runtime/executor/engine.ts),
  [`nodes/`](src/modules/runtime/nodes),
  [`context/`](src/modules/runtime/context),
  [`policies/`](src/modules/runtime/policies)
- Run pipeline: [`run.service.ts`](src/modules/runtime/run.service.ts),
  [`run.dispatcher.ts`](src/modules/runtime/run.dispatcher.ts),
  [`run.executor.ts`](src/modules/runtime/run.executor.ts), [`queues.ts`](src/modules/runtime/queues.ts),
  [`worker.ts`](src/modules/runtime/worker.ts)
- Run UI: [`runs-view.tsx`](src/components/runs-view.tsx),
  [`run-detail-view.tsx`](src/components/run-detail-view.tsx),
  [`run-harness-dialog.tsx`](src/components/builder/run-harness-dialog.tsx)
- Run/trace model: [`run.types.ts`](src/modules/runtime/run.types.ts),
  [`prisma/schema.prisma`](prisma/schema.prisma)
- LLM gateway: [`llm.gateway.ts`](src/modules/llm/llm.gateway.ts)
- Tools: [`tool.types.ts`](src/modules/tools/tool.types.ts),
  [`tool.registry.ts`](src/modules/tools/tool.registry.ts)
- Auth abstraction: [`src/lib/auth/provider.ts`](src/lib/auth/provider.ts)
- Brand mark & icons: [`mark-geometry.ts`](src/components/brand/mark-geometry.ts) (the one source
  of truth for the geometry), [`orqestra-mark.tsx`](src/components/brand/orqestra-mark.tsx) (the mark:
  the node that rides the ring, and the beat at the core as each lap closes),
  [`use-orbit-favicon.ts`](src/components/brand/use-orbit-favicon.ts) (the animated tab icon) and
  [`generate-icons.ts`](scripts/generate-icons.ts) — `pnpm icons` derives `icon.svg`, `favicon.ico`,
  `apple-icon.png` and `public/orqestra-mark-animated.svg` from that geometry

## 10. Roadmap

| Phase | Deliverable                      | Status                                                                                                                                                                                                                                                        |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Foundation & architecture**    | delivered                                                                                                                                                                                                                                                     |
| **1** | **Visual harness builder**       | delivered — projects, agents, harnesses, React Flow builder, node inspector, graph validation, draft autosave, immutable versions, import/export                                                                                                              |
| **2** | **Agent runtime**                | **this repository state** — compiler → execution plan, state machine, node executors, expression resolver, loop/limits/retry policies, tool permissions, LLM gateway (Gemini/Ollama/mock), queue + worker, runs API, SSE updates, run history & run detail UI |
| 3     | Evaluation framework             | Loop engineering, datasets/evaluators, harness optimization                                                                                                                                                                                                   |
| 4     | Evaluation framework             | `Dataset`/`Evaluator`/`Evaluation` concepts, module boundary                                                                                                                                                                                                  |
| 5     | Harness versioning & A/B testing | immutable versions, content hashes, run→version pinning                                                                                                                                                                                                       |
| 6     | Experiment engine                | `Experiment`/`ExperimentRun` concepts with version-pinned variants                                                                                                                                                                                            |
| 7     | Loop engineering                 | `loop` node type, events, iteration state                                                                                                                                                                                                                     |
| 8     | Harness optimization             | evaluation + experiment data model                                                                                                                                                                                                                            |
| 9     | Self-evolving harnesses          | `HarnessMutation`/`OptimizationRun` will be additive tables                                                                                                                                                                                                   |

**Phase 0 explicitly does not include:** the visual editor, multi-agent
orchestration, autonomous evolution, prompt optimization, complex RAG, arbitrary
code execution, billing, team collaboration, marketplace, enterprise RBAC,
advanced analytics, a complex memory system, or large evaluation datasets.

## License

Not yet specified — internal project.
