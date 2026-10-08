# Orqestra Architecture

This document explains the concepts Orqestra is built on, how the code is
organized, and where each later phase plugs in. Read it before adding a feature —
most review comments in this repository come down to "that logic is in the wrong
layer" or "that merged two concepts".

---

## 1. Vocabulary

```text
Agent          who the agent is          — identity, purpose, instructions, model, capabilities
Harness        how the agent behaves     — flow, tools, memory, context, loops, termination
Runtime        how a harness executes    — compiler → plan → node executors → tools/LLM
Tool           a capability the agent can call
Run            one execution of one harness version
Trace          the ordered events of a run
Evaluation     how good a run was
Experiment     which harness version is better, and why
```

Each of these is a **separate concept with a separate module and its own
persistence rules**. The most consequential separation is Agent vs Harness.

### Agent vs Harness

An `Agent` is a _persona plus configuration_: it carries base instructions
("You are a research agent…"), a model configuration (`gemini:gemini-2.0-flash`,
temperature), and the capabilities it is allowed to request. It says nothing about
sequencing, tool routing, looping, or termination.

A `Harness` is a **directed graph of behavior**. It decides how the task is
planned, which tools are called in which order, what happens when a critic
rejects an answer, when to stop, and how failures are handled.

```text
Agent:    Research Agent (v3)          Harness:  Research Harness (v4)

                                               Planner
                                                  ↓
                                               Search
                                                  ↓
                                       Evidence Collector
                                                  ↓
                                               Critic ──(reject)──┐
                                                  ↓              │
                                              Verifier ←─────────┘
                                                  ↓
                                           Final Response
```

Why the separation matters:

- the same agent can be run under many harnesses (harness is the experimental variable);
- the same harness can drive different agents (agent is the identity variable);
- experiments can vary one while holding the other constant — which is exactly what
  Phase 5/6 need;
- prompts and tools change far more often than identity, so versioning them
  separately keeps diffs meaningful and runs comparable.

The database reflects this: `Agent`/`AgentVersion` and `Harness`/`HarnessVersion`
are independent aggregates. `Run` references a `HarnessVersion` (required) and may
reference an `Agent`/`agentVersion` (optional in Phase 0, set when agent-driven
runs land).

### Versioning model (immutability + content hashes)

```text
Harness (mutable shell: name, description, currentVersion)
   ├── v1   HarnessVersion  — immutable, validated, content-hashed
   ├── v2
   ├── v3
   └── v4   ← currentVersion
```

- `HarnessVersion` rows are **write-once**. Publishing never updates a version.
- Each version stores its `definition` (the DSL JSON) and a `contentHash`:
  SHA-256 over a **canonical serialization** (object keys sorted, nodes and edges
  sorted by id). Two definitions that describe the same behavior hash identically
  regardless of authoring order.
- Publishing an identical definition is a no-op that returns the existing version.
- Every `Run` pins `harnessVersionId`, so results stay reproducible and any
  regression can be attributed to an exact configuration.

The same rules apply to `AgentVersion`.

### Runtime boundary

The runtime is domain logic, not a Next.js feature. `src/modules/runtime` contains
no React, no route handlers, and no server actions — it is plain TypeScript that a
web request, a queue worker, a CLI, or a test can drive.

```text
Harness Definition
   ↓  validateHarnessDefinition()   graph integrity (entry, exits, reachability, termination)
   ↓  compileHarness()              ExecutionPlan: normalized nodes/edges + adjacency + content hash
   ↓  Runtime (Phase 2)             walks the plan, emits RuntimeEvent per step
   ↓  Node executors (Phase 2)      one per node type
   ↓  Tool registry / LLM gateway   the only doors to capabilities and models
```

Phase 0 defines the contracts and the compiler; Node 2 implements execution:

- [`execution.types.ts`](src/modules/runtime/execution.types.ts) —
  `ExecutionContext`, `ExecutionState`, `ExecutionResult`, `NodeExecution`,
  `NodeExecutor`, `RuntimeEvent`
- [`compiler.ts`](src/modules/runtime/compiler.ts) — `compileHarness()` returns an
  `ExecutionPlan` or validator issues; nothing unvalidated can be enqueued
- [`queues.ts`](src/modules/runtime/queues.ts) / [`worker.ts`](src/modules/runtime/worker.ts) —
  BullMQ queue + worker entry (`pnpm worker`); the worker validates payloads with
  the same Zod schema the producer uses

**Execution is asynchronous by rule.** HTTP requests create a `Run` row and enqueue
a job; they never execute a harness inline.

### Tool abstraction

Tools are the agent's capabilities, exposed through one interface
([`tool.types.ts`](src/modules/tools/tool.types.ts)):

```ts
interface AgentTool<TIn, TOut> {
  id: string;
  name: string;
  description: string;
  version: number; // ToolVersion concept
  inputSchema: z.ZodType<TIn>; // every external input is validated
  execute(input: TIn, context: ToolContext): Promise<ToolResult<TOut>>;
}
```

The [`ToolRegistry`](src/modules/tools/tool.registry.ts) is the only way the
runtime reaches a tool. It erases generics safely (no `any`), validates input
before execution, and normalizes failures into `ToolError` with stable codes
(`TOOL_NOT_FOUND`, `INVALID_INPUT`, `EXECUTION_FAILED`).

`calculator` is the reference implementation; the tool library (web search, URL
fetch, HTTP, filesystem, memory, code execution) arrives with persistence for
`Tool`/`ToolVersion` in a later phase.

### LLM provider abstraction

```text
Orqestra runtime → LLM Gateway → LLMProvider → Gemini | Ollama | (Groq / OpenAI / Anthropic)
```

- Application code depends on the `LLMProvider` interface
  ([`llm.types.ts`](src/modules/llm/llm.types.ts)) only.
- [`llm.gateway.ts`](src/modules/llm/llm.gateway.ts) resolves `"provider:model"`
  references, reports configured/unconfigured providers without throwing, wraps
  every failure in `LLMProviderError` with a retryable flag, and records latency
  and token usage for future cost attribution.
- Providers live in `src/modules/llm/providers/*`; their request/response
  translation is pure functions so it is unit-testable without network access.
- **No provider SDK is imported anywhere else.** The Gemini and Ollama adapters
  call the public REST APIs directly, so the models a harness can use are data
  (`model` node config), not code.

### Run and trace model

```text
Run (pins harnessId + harnessVersionId, optional agentId/agentVersion)
 ├── RunStep 0  Planner    ── Trace (ordered RuntimeEvent JSON)
 ├── RunStep 1  Search
 ├── RunStep 2  Search
 ├── RunStep 3  Critic
 ├── RunStep 4  Verifier
 └── RunStep 5  Final
```

`Run` carries `status`, `input`, `output`, `tokenUsage`, `cost`, `latencyMs`,
`error`, `startedAt`/`completedAt`; `RunStep` carries `index` (unique per run),
`nodeId`/`nodeType`/`nodeLabel`, per-step input/output/error and timing. The model
was designed before any UI so the Phase 3 run lab needs no schema migration, and
multi-step trajectories (the thing that makes agent debugging hard) are
first-class from day one.

### Evaluation and experiments (concepts now, tables later)

- [`evaluation.types.ts`](src/modules/evaluation/evaluation.types.ts) — `Dataset`,
  `Evaluator` (`exact_match`, `contains`, `regex`, `json_schema`, `llm_judge`),
  `Evaluation`/`EvaluationScore`.
- [`experiment.types.ts`](src/modules/experiments/experiment.types.ts) —
  `Experiment` with **version-pinned** `ExperimentVariant`s and `ExperimentRun`.

Variants are pinned to `harnessVersionId` (never "latest") so an A/B comparison
cannot silently drift when someone edits the harness mid-experiment.

### Memory (reserved)

`src/modules/memory` deliberately contains only a README: short-term memory belongs
in Redis, long-term memory in PostgreSQL with pgvector, and both depend on a
running runtime. The harness DSL already has a `memory` node type with
`scope`/`maxItems`, so the schema will not change when the store arrives.

---

## 2. Layer rules

```text
app/ (pages, route handlers)   thin: validate, delegate, respond
   ↓
modules/*/**.service.ts        business rules, orchestration, errors
   ↓
modules/*/**.repository.ts     Prisma queries + row↔domain mapping
   ↓
lib/*                          infrastructure: prisma, redis, auth, logging, health
```

Hard rules:

1. **No business logic in route handlers.** A handler validates input, calls a
   service, maps the result (and errors) to HTTP. `/api/health` and
   `/api/auth/[...all]` are the reference examples.
2. **No business logic in React components.** Components render props and call
   hooks; server state lives in TanStack Query, editor drafts in Zustand.
3. **No direct database access from UI code**, and no LLM SDK calls from UI code —
   ever.
4. **Repositories own Prisma.** Services compose repositories; nothing else imports
   `@/lib/db/prisma` except repositories, health checks, and the seed.
5. **Validate all external input** with Zod: env, HTTP bodies, harness definitions,
   tool input, queue payloads.
6. **Errors are explicit and typed**: `HarnessValidationError`, `HarnessNotFoundError`,
   `AgentInputError`, `ToolError`, `LLMProviderError`, `RunNotFoundError`.
7. **Structured logging only** (`src/lib/logging/logger.ts`): JSON lines, redacted
   sensitive keys, `logger.child({ module: … })` inside modules. No `console.log`
   in application code.

## 3. Harness DSL and its validation rules

The DSL is defined once as Zod schemas
([`harness.schema.ts`](src/modules/harness/harness.schema.ts)); the TypeScript types
are inferred from them, so runtime validation and compile-time types cannot drift.

```ts
type HarnessDefinition = {
  schemaVersion: 1;
  id: string; // harness slug (stable, unique per project)
  version: number;
  name: string;
  description?: string;
  nodes: HarnessNode[]; // discriminated union on `type`
  edges: HarnessEdge[];
  entryNode: string;
  exitNodes: string[];
};
```

Node types: `model`, `prompt`, `tool`, `memory`, `planner`, `router`, `critic`,
`evaluator`, `condition`, `loop`, `human_approval`, `transform`. Each type has a
strict config object — unknown types and unknown config keys fail validation, so
typos surface immediately instead of silently doing nothing.

[`validateHarnessDefinition`](src/modules/harness/harness.validation.ts) enforces:

1. schema conformance (unknown node type / config key → `INVALID_SCHEMA`)
2. unique node ids and edge ids (no duplicate endpoints)
3. `entryNode` exists
4. every `exitNode` exists and is listed once
5. every edge references existing nodes
6. every node is reachable from `entryNode`
7. every node either has outgoing edges or is an exit node
8. exit nodes are terminal (no outgoing edges)

Cycles and self-edges are allowed — `loop` nodes are first-class, and rule 8 is
what makes termination decidable.

**Versioning strategy for the DSL itself:** `schemaVersion` identifies the dialect
of a stored definition. A future bump adds a migration path over stored
`HarnessVersion` rows; old versions keep validating against the schema they were
written with, and content hashes stay meaningful.

## 4. Request flows

**Health check**

```text
GET /api/health
  → connection()                      opt out of build-time prerendering
  → getHealthReport()                 src/lib/health/health.service.ts
  → checkDatabase() (SELECT 1)  checkRedis() (PING)  checkEnvironment()
  → 200 healthy | 503 degraded        structured body, no secrets, no connection strings
```

**Sign-in**

```text
POST /api/auth/sign-in/email
  → lib/auth/index.ts:getAuthProvider()      AuthProvider abstraction
  → BetterAuthProvider.handleRequest()       Better Auth + Prisma adapter
  → User/Session/Account rows in PostgreSQL
```

**Creating a run (used by Phase 2+)**

```text
createRun({ harnessVersionId, input })
  → harnessRepository.findVersionById()      version must exist
  → compileHarness(version.definition)       must still compile
  → runRepository.create()                   Run row, status QUEUED
  → enqueueRun({ runId, harnessVersionId })   BullMQ → worker process
```

The `Run` row exists before the job is enqueued, so a queue payload always points
at durable state.

## 5. Infrastructure & data

- **PostgreSQL + Prisma 7.** The connection URL lives in `prisma.config.ts`
  (Prisma 7 removed `url` from the datasource block); the client uses the
  `@prisma/adapter-pg` driver adapter and is generated into `src/generated/prisma`
  (git-ignored). `pnpm db:migrate` runs `prisma migrate dev && prisma generate`,
  because Prisma 7 no longer regenerates the client implicitly.
- **Redis + BullMQ.** `src/lib/redis/connection.ts` is the only place that parses
  `REDIS_URL` or builds options. The shared command client fails fast
  (`enableOfflineQueue: false`) while BullMQ gets its own connection with
  `maxRetriesPerRequest: null`, as it requires.
- **pgvector readiness.** `docker-compose.yml` uses `pgvector/pgvector:pg16`, and
  every high-churn payload (`definition`, `instructions`, `input`, `output`,
  `events`, `tokenUsage`) is a `Json` column. Embeddings can therefore be added as
  `Unsupported("vector")` columns plus an extension migration — additive, no
  restructuring.
- **Secrets.** `.env` is git-ignored; `.env.example` holds placeholders only. Auth
  secrets, provider keys, and connection strings never reach client bundles; the
  health endpoint reports only variable _names_.

## 6. Deliberate Phase 0 scope

Not implemented (by decision, with the boundary prepared):

| Not built                                                                  | Boundary that waits for it                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Visual harness editor                                                      | DSL + validation + `HarnessEditorState` store + `@xyflow/react`                  |
| Agent runtime / node executors                                             | `ExecutionPlan`, `ExecutionContext`, `RuntimeEvent`, queue + worker              |
| Run lab UI                                                                 | `Run`/`RunStep`/`Trace` tables and DTOs                                          |
| Evaluation, experiments, memory                                            | module folders, typed concepts, READMEs                                          |
| Tool library persistence                                                   | `AgentTool.version`, registry, `Tool`/`ToolVersion` will map 1:1                 |
| Multi-agent orchestration, RAG, code execution, billing, RBAC, marketplace | out of scope for the whole Phase 0–9 justification chain until their phase lands |

## 7. Adding to Orqestra

**A new node type:** add a strict config schema to
`HARNESS_NODE_TYPES` + the discriminated union, extend the validation tests, add
the executor in Phase 2 tooling, and ensure old stored versions still validate
(bump `schemaVersion` if the change is not backward compatible).

**A new tool:** implement `AgentTool` with a Zod input schema and register it in
`src/modules/tools/index.ts`; make sure the tool node's `toolId` matches.

**A new LLM provider:** implement `LLMProvider` in
`src/modules/llm/providers/`, register it in the gateway's built-ins, add its key
to the env schema + `.env.example`, and test its pure request/response translation.

**A new endpoint:** validate input with Zod, call a service, map typed errors to
status codes with `jsonError()`. If you need to touch Prisma directly, the logic
belongs in a service/repository instead.
