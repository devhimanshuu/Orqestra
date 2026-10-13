# Experiments module (Phase 4)

The experimentation platform: controlled, evidence-based comparisons between
immutable harness versions. "The model provides intelligence; the harness
controls behavior" — an experiment is only allowed to conclude what its
executed evidence supports.

## What lives here

- `experiment.inputs.ts` — Zod contracts for every experiment API: ceilings for
  candidates/cases/concurrency/replicates, and an explicit `confirm: true` for
  launching, because launch is the expensive step.
- `experiment.service.ts` — draft create/update, pre-flight planning, sealing,
  launch/dispatch, pause/resume/cancel, metrics, case views, selection,
  promotion and export. Domain logic never touches a UI component.
- `experiment.repository.ts` — Prisma access. A draft persists its pinned
  candidate rows at creation (`DraftCandidatePin`), so pre-flight, edit and seal
  all re-read the pins instead of the original request body; seal replaces those
  rows with the replicated batch plan in one transaction.
- `experiment.configuration.ts` — resolves a draft against the database
  (harness versions must compile and belong to one agent; dataset version;
  evaluator revisions) and separates hard `issues` (refused) from `warnings`
  (explained, never blocking — e.g. a run budget below the plan, which settles
  the experiment as partially completed instead of being rejected).
- `experiment.metrics.ts`, `experiment.ranking.ts`, `experiment.objective.ts`,
  `experiment.comparison.ts`, `experiment.statistics.ts`,
  `experiment.analysis.ts` — aggregates recomputed from persisted case rows,
  objective-constrained ranking (a constraint violation can never win),
  absolute/percentage movements (`null`, never `∞`, against a zero baseline),
  regression verdicts alongside execution-path leads, and paired evidence
  (confidence intervals, sign tests) that says "insufficient sample" rather
  than overclaiming.
- `experiment.authorization.ts` — workspace access plus selection/promotion
  gates as pure functions, unit-testable without a database.
- `experiment.lifecycle.ts` — the status state machine: DRAFT → QUEUED →
  RUNNING ⇄ PAUSED → COMPLETED / PARTIALLY_COMPLETED / FAILED / CANCELLED,
  with terminal states final.
- `jobs/` — dispatcher (`auto` probes Redis, `queue` needs the worker, `inline`
  runs in-process) and a claim-based orchestrator with interleaved/randomized
  scheduling, budgets, durable pause/cancel observation and idempotent
  redelivery.

## Invariants

- **Pins are immutable.** Baseline and candidates reference published,
  content-hashed `HarnessVersion` rows; the sealed snapshot fixes the dataset
  version, evaluator revisions, objective, constraints, execution settings,
  engine version and pricing version. Nothing about an experiment may mutate a
  published version.
- **Comparable conditions.** Every candidate runs the same dataset version with
  the same evaluator snapshot and comparable execution settings; model provider
  and model ids are recorded per run.
- **No invented numbers.** Rates over zero items are `null`; cost is always an
  estimate carrying its pricing source; statistical claims require enough
  paired cases and are qualified when they do not.
- **Leads vs verdicts.** A changed execution path is reported as a lead
  alongside any regression verdict, never instead of it.
- **Promotion is separate from selection.** Selection records a human decision;
  promotion re-checks every gate (settled experiment, sealed batch, pass-rate
  threshold) and advances the harness's `currentVersion` forward only —
  publishing a version never moves that pointer.

## Verification

- `pnpm test` — unit tests for scheduling, clamping, draft round-trips,
  ranking, statistics, comparison/regression detection, lifecycle transitions
  and authorization gates.
- `pnpm verify:phase4` — end-to-end script (mock model, inline dispatch) over a
  real database: creation → pre-flight → seal → execution → metrics → ranking →
  comparison → selection → promotion (v1 → v2 with the hash unchanged),
  regression and path-lead reporting, pause/resume, redelivery safety, budget
  stops, cancellation and workspace isolation.
