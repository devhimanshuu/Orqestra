# Contributing to Orqestra

Thanks for working on Orqestra. This document is the short version of how we build
here: setup, the rules that keep the architecture intact, and what "done" means.

---

## Getting set up

```bash
pnpm install
docker compose up -d          # PostgreSQL (pgvector image) + Redis
cp .env.example .env          # set a real BETTER_AUTH_SECRET: openssl rand -base64 48
pnpm db:migrate               # apply migrations + regenerate the Prisma client
pnpm db:seed                  # demo user, workspace, project, sample agent + harness
pnpm dev                      # http://localhost:3000
```

Useful commands:

| Command                        | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm dev`                     | Next.js dev server                                                             |
| `pnpm build` / `pnpm start`    | Production build / serve it                                                    |
| `pnpm worker`                  | BullMQ worker for the run queue                                                |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript (strict)                                                   |
| `pnpm test`                    | Vitest unit tests                                                              |
| `pnpm test:e2e`                | Playwright (builds and starts the app on port 3100; needs DB running + seeded) |
| `pnpm verify`                  | lint + typecheck + unit tests + production build                               |
| `pnpm db:generate`             | Regenerate the Prisma client only (`pnpm db:migrate` does it for you)          |
| `pnpm db:studio`               | Prisma Studio                                                                  |
| `pnpm format`                  | Prettier                                                                       |

## Before you open a change

Run `pnpm verify` and `pnpm test:e2e` (when your change touches the app surface).
A change is **not** done if it only passes because a test was weakened, a type was
cast to `any`, an error was swallowed, or a lint rule was disabled for convenience.

## The rules

### Boundaries (the important ones)

1. **Route handlers stay thin.** Validate → service → response. Business logic in a
   handler is a review blocker.
2. **Components render; they do not decide.** No business logic, no direct database
   access, no LLM SDK calls from React. Server state goes through TanStack Query;
   editor drafts through Zustand. Server-only code must not be imported by client
   components (share DTOs from `src/types` instead).
3. **Domain modules stay framework-free.** `src/modules/**` may not import from
   `src/app`, `src/components`, React, or `next/*` (exceptions: `next/headers` in
   `src/lib/auth/session.ts` — the DAL is intentionally the boundary).
4. **Repositories own Prisma.** Services compose repositories; UI never sees a
   Prisma type. Map rows to domain types at the repository edge.
5. **Agent ≠ Harness.** Never merge identity (instructions, model, capabilities)
   into behavior (flow, tools, loops, termination).

### Code quality

- TypeScript strict mode; `noUncheckedIndexedAccess` is on. Avoid `any` — use
  `unknown` plus a schema or a type guard. Justify any necessary cast in a comment.
- **Validate every external input** with Zod: env, request bodies, harness
  definitions, queue payloads, tool input.
- **No duplicated business logic.** One place decides versioning, one place hashes
  definitions, one place parses Redis URLs, and so on.
- **Errors are explicit.** Throw typed domain errors (`HarnessValidationError`,
  `ToolError`, `LLMProviderError`, …); never return `null` to mean "something failed".
- **Logging goes through the structured logger**, with `logger.child({ module: … })`.
  No `console.log` in application code, and never log credentials.
- **No secrets in the repo or in client code.** `.env` stays untracked; extend
  `.env.example` (with classification comments) when you add a variable, and add
  it to the Zod schema in `src/config/env.ts`.
- Prefer small modules, clear interfaces, and explicit boundaries over clever
  abstraction. Add a dependency only when the platform genuinely needs it.

### Tests

- Pure logic (validation, serialization/hashing, translation layers, registries,
  compilers) gets unit tests next to the code as `*.test.ts`.
- Integration level behaviour (auth redirect, sign-in, health) belongs in
  `e2e/*.spec.ts`.
- When you fix a bug, add the test that would have caught it.

### Database changes

- `pnpm db:migrate` (runs `prisma migrate dev && prisma generate` — Prisma 7 does
  not regenerate the client implicitly).
- Migrations must be additive-friendly: immutable rows (`HarnessVersion`,
  `AgentVersion`, `Run`, `RunStep`) are never mutated by application code, and
  vector/embedding columns arrive as new migrations, not schema rewrites.
- Keep seeding idempotent (`upsert` by natural keys) and ASCII-only, so seeds work
  on PostgreSQL clusters that are not UTF-8 encoded.

## Commit and PR conventions

- One logical change per commit; imperative subject lines
  (`add harness content hashing`, not `added`/`updated stuff`).
- Describe **why** in the body, plus how you verified it (commands and results).
- Never commit generated artifacts: `src/generated/**`, `.next/`, `playwright-report/`,
  `test-results/`, `.env*` (except `.env.example`).
- Update `README.md` / `ARCHITECTURE.md` when you change behaviour, boundaries, or
  the environment surface. A new phase capability should also update the roadmap
  table (and stop claiming the feature is "not implemented").

## Scope discipline

Orqestra's phases are deliberate. Before building something from a later phase
(the visual editor, runtime execution, evaluation, experiments, memory,
optimization), confirm it belongs to the current phase — the prepared boundaries
in [`ARCHITECTURE.md`](./ARCHITECTURE.md#6-deliberate-phase-0-scope) exist so the
work lands cleanly _when its phase arrives_, not early.
