# Orqestra

**Engineer, execute, evaluate, and eventually evolve AI-agent harnesses.**

Orqestra is not another agent builder. The LLM is one component; the _harness_ —
the way an agent reasons, uses tools, manages context and memory, loops, recovers
from failures, and terminates — is the product.

> **Current status: Phase 0 — Foundation & Architecture.**
> The architecture, boundaries, persistence model, provider/tool abstractions,
> and developer experience are in place. The visual builder, runtime, and
> evaluation stack land in later phases (see [Roadmap](#roadmap)).

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
│   ├── runtime/          #   compiler, run/trace model, queues, worker
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

| Concern                | Choice                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| Framework              | Next.js 16 (App Router, Cache Components), React 19, TypeScript (strict)   |
| Styling / UI           | Tailwind CSS v4, shadcn/ui primitives                                      |
| Visual graph (Phase 1) | `@xyflow/react` (React Flow) — installed, not yet used                     |
| Client state           | Zustand (editor drafts), TanStack Query (server state)                     |
| Database               | PostgreSQL + Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`)    |
| Queue                  | Redis + BullMQ (runs never execute inside a request)                       |
| Auth                   | Better Auth behind an `AuthProvider` abstraction                           |
| Validation             | Zod (env, harness DSL, tool input, queue payloads)                         |
| Logging                | Structured JSON logger (no scattered `console.log`)                        |
| Tests                  | Vitest (unit), Playwright (e2e smoke)                                      |
| Lint / format          | ESLint (flat config, `eslint-config-next` + Prettier)                      |
| LLM providers          | Gateway + Gemini and Ollama adapters (Groq/OpenAI/Anthropic keys reserved) |

## 5. Local setup

Prerequisites: **Node.js ≥ 20.9**, **pnpm 10**, **Docker** (for PostgreSQL + Redis).

```bash
# 1. install dependencies
pnpm install

# 2. start PostgreSQL and Redis
docker compose up -d

# 3. create your environment file
cp .env.example .env
#    then set a real BETTER_AUTH_SECRET:  openssl rand -base64 48

# 4. create the schema and seed demo data
#    (db:migrate applies migrations AND generates the Prisma client into
#    src/generated/prisma, which type-checking and the build require)
pnpm db:migrate
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

## 6. Environment variables

The environment is validated with Zod at startup (and inside `/api/health`).
A missing or malformed _required_ variable makes the server refuse to start with
an explicit list of problems — values are never echoed into logs.

| Variable                                              | Class                               | Notes                                                                                                           |
| ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | **required**                        | `postgresql://…`; must match `docker compose`                                                                   |
| `REDIS_URL`                                           | **required**                        | `redis://…`                                                                                                     |
| `BETTER_AUTH_SECRET`                                  | **required**, production-only value | ≥ 32 chars; rotate per environment                                                                              |
| `APP_URL`                                             | optional                            | Public base URL; used for auth base URL and origin checks                                                       |
| `BETTER_AUTH_TRUSTED_ORIGINS`                         | optional                            | Comma-separated extra origins (wildcards allowed). Development additionally trusts any localhost/127.0.0.1 port |
| `LOG_LEVEL`                                           | optional                            | `debug` \| `info` \| `warn` \| `error` (default `info`)                                                         |
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
| `pnpm worker` | BullMQ worker for the `orqestra.runs` queue          |

The worker is a separate process by design: long-running agent work must never run
inside an HTTP request. In Phase 0 it validates job payloads and acknowledges them
(execution is Phase 2).

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
  translation, tool registry behaviour, and the harness compiler.
- **E2E tests** run against a production build (Playwright starts
  `next build && next start` on port 3100) and require the database to be running,
  migrated, and seeded. They cover: the app loads, the login form renders,
  `/api/health` returns a structured report, anonymous visitors are redirected to
  `/login`, and the seeded user can sign in and see the dashboard.
- First run only: `pnpm exec playwright install chromium`.

## 9. Project structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module responsibilities and the
extension points for later phases. Key entry points:

- Harness DSL & rules: [`src/modules/harness/harness.schema.ts`](src/modules/harness/harness.schema.ts),
  [`harness.validation.ts`](src/modules/harness/harness.validation.ts),
  [`harness.serialize.ts`](src/modules/harness/harness.serialize.ts)
- Harness and agent versioning services: [`harness.service.ts`](src/modules/harness/harness.service.ts),
  [`agent.service.ts`](src/modules/agents/agent.service.ts)
- Runtime boundary: [`execution.types.ts`](src/modules/runtime/execution.types.ts),
  [`compiler.ts`](src/modules/runtime/compiler.ts), [`queues.ts`](src/modules/runtime/queues.ts),
  [`worker.ts`](src/modules/runtime/worker.ts)
- Run/trace model: [`run.types.ts`](src/modules/runtime/run.types.ts),
  [`prisma/schema.prisma`](prisma/schema.prisma)
- LLM gateway: [`llm.gateway.ts`](src/modules/llm/llm.gateway.ts)
- Tools: [`tool.types.ts`](src/modules/tools/tool.types.ts),
  [`tool.registry.ts`](src/modules/tools/tool.registry.ts)
- Auth abstraction: [`src/lib/auth/provider.ts`](src/lib/auth/provider.ts)

## 10. Roadmap

| Phase | Deliverable                         | Phase 0 preparation                                                                   |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| **0** | **Foundation & architecture**       | **this repository state**                                                             |
| 1     | Visual harness builder (React Flow) | DSL, validation, Zustand editor store, `@xyflow/react` installed                      |
| 2     | Agent runtime                       | `ExecutionContext`/`State`/`Result`, node executor contract, compiler, queue + worker |
| 3     | Run lab & tracing                   | `Run`/`RunStep`/`Trace` tables, `RuntimeEvent` union                                  |
| 4     | Evaluation framework                | `Dataset`/`Evaluator`/`Evaluation` concepts, module boundary                          |
| 5     | Harness versioning & A/B testing    | immutable versions, content hashes, run→version pinning                               |
| 6     | Experiment engine                   | `Experiment`/`ExperimentRun` concepts with version-pinned variants                    |
| 7     | Loop engineering                    | `loop` node type, events, iteration state                                             |
| 8     | Harness optimization                | evaluation + experiment data model                                                    |
| 9     | Self-evolving harnesses             | `HarnessMutation`/`OptimizationRun` will be additive tables                           |

**Phase 0 explicitly does not include:** the visual editor, multi-agent
orchestration, autonomous evolution, prompt optimization, complex RAG, arbitrary
code execution, billing, team collaboration, marketplace, enterprise RBAC,
advanced analytics, a complex memory system, or large evaluation datasets.

## License

Not yet specified — internal project.
