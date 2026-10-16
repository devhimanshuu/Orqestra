# Orqestra

**Engineer, execute, evaluate, and eventually evolve AI-agent harnesses.**

Orqestra is not another agent builder. The LLM is one component; the _harness_ —
the way an agent reasons, uses tools, manages context and memory, loops, recovers
from failures, and terminates — is the product.

> **Current status: Phase 5 — Loop Engineering & Harness Optimization.**
> Projects, agents, harnesses, the visual builder, the agent runtime (compiler →
> execution plan → state machine → trace → SSE), the run lab (run history, run
> detail, live timeline), the evaluation engine (datasets, evaluators, sealed
> evaluation batches, metrics, regression comparison, sanitized exports), the
> experimentation platform (immutable baseline/candidate pins, execution through
> the same runtime, objective-driven ranking, statistical evidence, gated
> promotion of the winning version), and the optimization engine (bounded
> sessions, deterministic failure analysis with LLM-labelled hypotheses, typed
> harness mutations, candidate validation, reuse of the existing evaluation
> engine, deterministic acceptance policies and a complete audit trail) are in
> place. The loop proposes and measures; the developer decides — a published
> harness version is never rewritten (see [Roadmap](#roadmap)).

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
│   ├── evaluation/       #   datasets, evaluators, batches, metrics, comparison
│   ├── tools/            #   tool interface + registry + example tool
│   ├── llm/              #   gateway + Gemini / Ollama adapters
│   ├── experiments/      #   wizard, configuration, ranking, comparison, promotion
│   └── memory/           #   reserved (later phase)
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

### The Phase 3 loop

Datasets are versioned test corpora. A dataset's **working set** is editable; a
published **version** is an immutable, content-hashed snapshot. Publishing an
unchanged corpus returns the existing version instead of minting a duplicate.

Evaluators are configured scoring procedures: deterministic checks
(`exact_match`, `contains`, `json_schema`, `tool_usage`, `harness_compliance`) and
`llm_judge`. A configuration is validated against its kind's strict schema before
it is stored, and changing it publishes a **new immutable revision**.

An evaluation is a **sealed batch**: harness version × dataset version ×
pinned evaluator revisions. Creation snapshots all three, then executes case by
case through the ordinary runtime — every case is a real run with a real trace.

```text
POST /api/datasets            → create (with optional inline cases) or list
POST /api/datasets/:id/cases  → edit the working set (versions never change)
POST /api/datasets/:id/versions → publish the working set (idempotent)
POST /api/evaluators          → configure + validate an evaluator
GET  /api/evaluators/validate → check a config without saving it
POST /api/evaluations         → seal a batch → dispatch (queue or inline)
GET  /api/evaluations/:id/cases   → case verdicts, paginated
GET  /api/evaluations/:id/metrics → persisted metrics (never invented)
POST /api/evaluations/:id/cancel  → cancel: keeps every result already produced
GET  /api/evaluations/compare → align two batches by case key; report regressions
GET  /api/evaluations/:id/export  → sanitized report (evidence is redacted)
POST /api/runs/:id/evaluations    → score one finished run, without touching it
```

Evaluation rules are deliberately conservative: a missing score is never a zero
and an unavailable metric is `null`, not `0`; a crashing evaluator records an
`ERROR` verdict instead of failing the run; cost is always an estimate with its
pricing source and unpriced models named; comparison refuses batches from
different datasets and aligns cases by their stable `caseKey`, never by position.

### The Phase 5 loop

An **optimization session** is a bounded improvement process over one harness:
baseline version × sealed source evaluation batch × objective × hard constraints ×
ceilings (iterations, candidates, runs, tokens, cost, wall-clock). Starting it
seals an immutable configuration snapshot; the session then runs
`analyze → hypothesize → mutate → validate → evaluate → compare → decide`,
checkpointing every step so a crashed pass resumes rather than replays.

Failure analysis is deterministic first — evaluator verdicts plus structural
facts (tool repetition, loop iterations, latency and token ceilings measured
against the batch's own norm) — and every finding carries the case keys, run ids
and step indexes that support it. When a session is given an `analyzerModel`, an
LLM may then name the *pattern* across those findings; its claims are stored with
`confidence: "llm"`, may only cite cases the rules actually observed, and its
analyzer tokens are accounted apart from agent runs.

Hypotheses become **typed mutations** (`set_prompt_instruction`,
`set_node_config`, `insert_node`, `remove_node`, `reconnect_edge`) applied to a
structural clone of the baseline. A candidate passes the same graph validator a
published harness passes, is stored as an **immutable new version**, and is
evaluated through the ordinary runtime and evaluation engine over the same
dataset version and evaluator revisions as the baseline. Acceptance is
deterministic: a hard constraint beats a better primary metric, a small sample is
indicative rather than established, and a rejected candidate never outranks an
accepted one. Promotion is a separate, explicitly attributed action that only
moves `Harness.currentVersion` forward.

```text
POST /api/optimizations                    → create a draft session
POST /api/optimizations/plan               → pre-flight: volume, issues, warnings
POST /api/optimizations/:id/start          → seal the snapshot and dispatch a pass
POST /api/optimizations/:id/cancel         → durable cancellation
POST /api/optimizations/:id/review         → approve or reject a parked candidate
POST /api/optimizations/:id/candidates     → attach a hand-built candidate version
POST /api/optimizations/:id/promote        → the only way a candidate reaches currentVersion
GET  /api/optimizations/:id/candidates     → every candidate, with its evidence
GET  /api/optimizations/:id/report         → the persisted report
GET  /api/optimizations/:id/export         → JSON or Markdown engineering report
```

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
- **Runtime verification** (`pnpm exec tsx scripts/verify-phase2.ts`, or
  `pnpm verify:phase2`) executes a real harness against the real database through
  the production path — happy path, invalid tool, max iterations, retry,
  cancellation, worker job processing, duplicate delivery and cancellation of a
  running run — and prints a check report.
- **Evaluation verification** (`pnpm exec tsx scripts/verify-phase3.ts`, or
  `pnpm verify:phase3`) drives the whole evaluation engine against the real
  database: dataset versions (including the no-op publish), evaluator validation
  and revisions, a sealed baseline batch, a regressed candidate batch, the
  regression comparison, run-level evaluation with SKIPPED semantics, sanitized
  export, dataset export/import round trip, and the delete guards.
- **Experiment & optimization verification** (`pnpm verify:phase4`,
  `pnpm verify:phase5`) drive the experimentation and optimization engines end to
  end against the real database: pinned candidates, execution through the same
  runtime, ranking and comparison, promotion gates, and — for Phase 5 — findings
  linked to real runs, typed change sets, candidate validation, deterministic
  accept/reject, the approval gate, run budgets, cancellation, manual
  candidates, a labelled LLM-assisted analysis pass, workspace isolation and
  proof that every published version stayed byte-identical.
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
    (cancel vs retry), and the builder's Run dialog with its execution preview;
  - **Phase 3 evaluation UI**: create a dataset → add a case → publish a version;
    configure an evaluator (validated before saving, edits create revisions); start
    an evaluation from the run lab and watch it settle on the detail page (progress,
    metrics, case verdicts); compare two settled batches and read the verdict.
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
- Evaluation engine: [`dataset.service.ts`](src/modules/evaluation/dataset.service.ts),
  [`evaluator.service.ts`](src/modules/evaluation/evaluator.service.ts),
  [`evaluation.service.ts`](src/modules/evaluation/evaluation.service.ts),
  [`case.runner.ts`](src/modules/evaluation/case.runner.ts),
  [`jobs/orchestrator.ts`](src/modules/evaluation/jobs/orchestrator.ts),
  [`metrics.ts`](src/modules/evaluation/metrics.ts),
  [`comparison.ts`](src/modules/evaluation/comparison.ts)
- Evaluator implementations: [`evaluators/`](src/modules/evaluation/evaluators)
  (exact match, contains, JSON schema, tool usage, harness compliance, LLM judge)
- Evaluation UI: [`datasets-view.tsx`](src/components/evaluation/datasets-view.tsx),
  [`evaluators-view.tsx`](src/components/evaluation/evaluators-view.tsx),
  [`evaluations-view.tsx`](src/components/evaluation/evaluations-view.tsx),
  [`evaluation-detail-view.tsx`](src/components/evaluation/evaluation-detail-view.tsx),
  [`comparison-view.tsx`](src/components/evaluation/comparison-view.tsx)
- Optimization engine: [`optimization.service.ts`](src/modules/optimization/optimization.service.ts),
  [`analysis/failure-analysis.ts`](src/modules/optimization/analysis/failure-analysis.ts),
  [`analysis/llm-analysis.ts`](src/modules/optimization/analysis/llm-analysis.ts),
  [`mutations/apply.ts`](src/modules/optimization/mutations/apply.ts),
  [`policies/acceptance.ts`](src/modules/optimization/policies/acceptance.ts),
  [`jobs/orchestrator.ts`](src/modules/optimization/jobs/orchestrator.ts),
  [`reporting/report.ts`](src/modules/optimization/reporting/report.ts)
- Optimization UI: [`optimizations-view.tsx`](src/components/optimization/optimizations-view.tsx),
  [`optimization-detail-view.tsx`](src/components/optimization/optimization-detail-view.tsx)
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
| **2** | **Agent runtime**                | delivered — compiler → execution plan, state machine, node executors, expression resolver, loop/limits/retry policies, tool permissions, LLM gateway (Gemini/Ollama/mock), queue + worker, runs API, SSE updates, run history & run detail UI                                  |
| **3** | **Evaluation engine & run lab**  | delivered — versioned datasets, configured evaluators (deterministic + LLM judge), sealed evaluation batches with pinned snapshots, per-case verdicts with evidence, persisted metrics, regression comparison, sanitized exports, run-level evaluation                                                        |
| **4** | **Experiments**                  | delivered — multi-step creation wizard, immutable baseline/candidate pins, execution through the existing runtime with pause/resume/cancel and budgets, live progress, objective-constrained ranking, statistical evidence with qualified claims, comparison view with regression/path-lead analysis, gated promotion of the winning version to the harness's current version                                                                                          |
| **5** | **Loop engineering & harness optimization** | delivered — bounded optimization sessions sealed to an immutable snapshot, deterministic failure analysis (plus a fenced, labelled LLM-assisted pass), structured hypotheses, typed and auditable harness mutations, candidate validation against the published-graph rules, evaluation through the existing runtime and evaluation engine, objective-constrained acceptance with hard constraints, iteration/run/token/cost ceilings with durable cancellation, the approval gate, a full timeline, report and JSON/Markdown export, and promotion that only ever moves forward |
| 6     | Memory & context engineering     | short-term in Redis, long-term in PostgreSQL + pgvector; the `memory` node type already exists in the DSL                                                                                                                       |
| 7     | Multi-agent orchestration        | delegation between agents inside one harness, with the same trace and evaluation model                                                                                                                                    |
| 8     | Self-evolving harnesses          | continuous, gated optimization across a lineage of versions — always human-approved, never autonomous |

**Phase 0 explicitly does not include:** the visual editor, multi-agent
orchestration, autonomous evolution, prompt optimization, complex RAG, arbitrary
code execution, billing, team collaboration, marketplace, enterprise RBAC,
advanced analytics, a complex memory system, or large evaluation datasets.

## License

Not yet specified — internal project.
