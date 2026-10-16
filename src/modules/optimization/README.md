# Optimization module (Phase 5)

Loop engineering: an evidence-driven, bounded process that improves a harness's
measurable weaknesses and never touches a published version. "The model provides
intelligence; the harness controls behavior" — so the loop works on the harness,
in small typed changes, and every improvement is traceable to a candidate version
and to the evaluation that proved it.

```text
analyze → hypothesize → mutate → validate → evaluate → compare → accept or reject → repeat
```

## What lives here

- `optimization.types.ts` — the vocabulary, fixed once: session, finding,
  hypothesis, candidate, mutation, decision, event; the objective, the hard
  constraints, the loop ceilings, and the derived views. Every measurement is
  `number | null` and `null` means *not measured* — an improvement that cannot be
  evidenced is inconclusive, never claimed.
- `optimization.inputs.ts` — Zod contracts for the API, including the platform
  ceilings (iterations, candidates, runs) that are enforced again in the service.
- `optimization.repository.ts` — Prisma access and the row↔domain mapping. It
  loads a whole source batch in three queries, never one per case.
- `optimization.lifecycle.ts` — the status state machine (DRAFT → QUEUED →
  RUNNING ⇄ WAITING_FOR_REVIEW → COMPLETED / PARTIALLY_COMPLETED / FAILED /
  CANCELLED), validated on every transition, plus the rule that derives a
  settled status from what actually happened.
- `analysis/failure-analysis.ts` — deterministic rules over real evaluation and
  run data: evaluator verdicts, structural checks (tool repetition, loop
  iterations, latency and token ceilings against the batch's own norm) and the
  runtime's step failures. Findings carry the case keys, run ids and step
  indexes that support them — never invented evidence.
- `analysis/llm-analysis.ts` — the opt-in second opinion, gated on the session's
  `analyzerModel`. It reads only the deterministic findings and may add
  *patterns*, each stored with `confidence: "llm"` and `isLlm: true` so a
  model-shaped claim can never read as fact. It is fenced: a claim naming a case
  the rules never observed is dropped, it may not introduce run, evaluator or
  trace references, an unparseable answer is a no-op, and a provider failure is
  recorded as an event instead of failing the session. Its tokens are accounted
  separately from agent runs (`OptimizationSession.analyzerTokenUsage`).
- `hypotheses/` — `generate.ts` turns each finding into at most two testable
  hypotheses (the smallest change first, and a verification step where a graph
  change is genuinely reasonable), and `fingerprint.ts` hashes the *effect* of a
  proposal so the same observation cannot be proposed twice in one session.
- `strategies/registry.ts` — what typed operations test a hypothesis. The
  rule-based strategy re-runs the deterministic rule and matches by fingerprint
  (no cost, reproducible); the LLM-assisted strategy asks a configured provider
  and then treats the answer as untrusted data that must parse as the mutation
  schema and survive the mutation engine, the validator and every budget.
- `mutations/operations.ts`, `mutations/apply.ts` — the typed operation
  vocabulary (`set_prompt_instruction`, `set_node_config`, `insert_node`,
  `remove_node`, `reconnect_edge`), whose fields are bounded by policy (allowed
  prompt fields, numeric ranges, insertable node types), and an applier that
  works on a structural clone and records refused operations with their reasons.
- `validation/candidate-validation.ts` — the candidate must pass the *same*
  graph validator a published harness passes, keep the baseline's entry/exit
  nodes, and actually change something. A failing candidate is recorded as
  INVALID with its issues and never reaches execution.
- `policies/acceptance.ts`, `policies/stopping.ts` — deterministic verdicts: a
  hard constraint beats a better primary metric; a small sample is *indicative*,
  not established; and every ceiling (iterations, candidates, runs, tokens,
  cost, wall-clock, invalid streaks, stall) is checked before an iteration
  starts, so no pass can overshoot the budget it was given.
- `scoring/ranking.ts` — ranks accepted candidates by the objective; a rejected
  candidate never outranks an accepted one, and ties break deterministically on
  cost, then label.
- `reporting/report.ts` — the persisted report: objective, constraints, baseline,
  iterations, findings, accepted and rejected candidates with their reasons, the
  recommendation and its rationale, and the usage the whole session spent.
- `optimization.authorization.ts` — review and promotion gates as pure
  functions: approval needs a parked session, a validated candidate and the
  stored definition a resumed pass would publish; promotion needs a settled
  session, a measured candidate, a published version and a sealed batch. An
  override is possible, but it must carry a reason and can never promote
  something that does not exist.
- `optimization.service.ts` — the only entry point: resolution of every pinned
  reference through the workspace → project → agent chain, sealing, start and
  resume, cancellation, review, manual candidates, promotion and export.
- `jobs/` — the dispatcher (`auto`/`queue`/`inline`, same as runs and
  evaluations), the queue (one job per pass) and the orchestrator: the loop
  itself, claim-based and checkpointed, so a crashed pass is resumed rather than
  replayed and an approved candidate is never lost.

## Invariants

- **The baseline is evidence, not a pointer.** A session's baseline must be the
  harness version its source batch actually ran; otherwise the comparison would
  be against another version's numbers, and the server refuses it.
- **Published versions are immutable.** Candidates are *new* immutable versions
  created from a mutated copy of the baseline definition. The harness's draft and
  its `currentVersion` are never written here; only an explicit, attributed
  promotion advances that pointer, forward only.
- **The loop is bounded before it runs.** Iteration, candidate, run, token, cost
  and wall-clock ceilings are checked before each iteration and before each
  evaluation.
- **Cancellation is observed, not simulated.** The flag is durable and read
  between iterations, candidates and cases.
- **The model proposes; the platform decides.** LLM output is untrusted data
  that must parse as the mutation schema, and every acceptance decision is
  deterministic, testable code.
- **Missing data is not zero.** A rate over zero items is `null`; an
  unevaluated candidate has no verdict; a proposal that cannot be evidenced is
  inconclusive.
- **The loop pays for what it uses.** Agent-run tokens and cost come from real
  run metrics; the analysis pass counts against `analyzerTokenUsage`, never
  against a candidate's evaluation, so an optimization decision is never flattered
  by cheaper bookkeeping.

## Verification

- `pnpm test` — unit tests for the acceptance policy (constraints beat metrics,
  indicative vs established, zero baselines), the stopping conditions and their
  ordering, lifecycle transitions, review/promotion authorization, failure
  classification, mutation application (the baseline is never mutated), and the
  LLM analyzer's fences (taxonomy, observed case keys only, no invented trace
  evidence, labelled findings, provider failure handled).
- `pnpm verify:phase5` — end-to-end script (deterministic mock model, inline
  dispatch) over a real database: baseline evaluation → findings linked to real
  runs → hypotheses → candidates with typed change sets → validation →
  evaluation through the existing engine → acceptance and rejection with
  reasons → the persisted report and its recommendation → the approval gate
  (park, survive a stray pass, approve, evaluate the approved definition) →
  reviewer rejection → run budgets → cancellation → manual candidates →
  promotion (forward only, baseline hash unchanged) → workspace isolation →
  a scripted, llm-labelled analysis pass whose tokens are accounted separately.
