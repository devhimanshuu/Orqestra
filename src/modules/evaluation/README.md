# Evaluation module

Datasets, evaluators and evaluation batches — the engine behind the run lab.

## Vocabulary

| Concept              | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Dataset**          | A versioned collection of test cases (input + optional expected output + metadata + tags).   |
| **Dataset version**  | An immutable, content-hashed snapshot of the working set. Publishing an unchanged set is a no-op. |
| **Evaluator**        | A configured scoring procedure: a deterministic check or an LLM judge.                        |
| **Evaluator revision** | An immutable kind + validated config + weight. Editing a config publishes a new revision.   |
| **Evaluation batch** | A sealed experiment: harness version × dataset version × pinned evaluator revisions.         |
| **Evaluation case**  | One dataset case inside a batch: its run (`Run`), its evaluator verdicts, its status.        |
| **Evaluation result** | One evaluator's verdict on one run: score, pass flag, explanation, structured evidence.       |

## Files

- `evaluation.types.ts` — the vocabulary, `EvaluationInput`/`RunObservation`, aggregate types.
- `dataset.*.ts` — dataset contracts (`dataset.schema.ts`, `dataset.inputs.ts`), service,
  repository. Imports accept either a plain `{ name, cases }` document or an exported
  `{ schemaVersion, dataset, cases }` file.
- `evaluator.*.ts` — evaluator configuration contracts, service, repository.
- `evaluators/` — the implementations, one file per kind, behind `evaluators/contract.ts`:
  `exact_match`, `contains`, `json_schema`, `tool_usage`, `harness_compliance`, `llm_judge`.
- `evaluator.registry.ts` — the single entry point (`runEvaluator`) that validates config,
  times the call and turns failures into `ERROR` records with a retryability flag.
- `evaluation.service.ts` — batch lifecycle: seal, start, list, cancel, finalize, metrics,
  comparison, run-level evaluation, sanitized export.
- `case.runner.ts` — one case end to end: create run → execute through the runtime → score.
- `jobs/` — dispatcher (queue/inline/auto), BullMQ queue, orchestrator (bounded parallelism,
  atomic claims, per-case retry, cancellation), job payload contracts.
- `scoring.ts` — weighted aggregation with the two explicit policies (`REQUIRE_ALL`,
  `IGNORE_MISSING`); a missing score is never a zero.
- `metrics.ts` — batch and run metrics, all derived from persisted rows.
- `comparison.ts` — case-key alignment, metric deltas, regression detection.
- `pricing.ts` — model pricing table and cost estimation (always an estimate).
- `sanitize.ts` — redaction used by exports so quoted agent output cannot leak a secret.
- `observation.ts` — the detached `RunObservation` projection evaluators receive.
- `testing/fixtures.ts` — shared fixtures for the unit tests.

## Rules

1. **A batch is sealed.** Creation snapshots the harness version, the dataset cases and the
   evaluator revisions. Nothing after creation can change what it means.
2. **A failed run is not a failed evaluation.** The runtime's status is passed to evaluators
   read-only; a crashing evaluator records `ERROR` and the run keeps its own result.
3. **Nothing is invented.** Missing scores are `null` (with the aggregate marked
   `INCOMPLETE`/`FAILED`, never averaged over silently), cost is an estimate with sources and
   unpriced models, and unavailable deltas are `null` rather than `0`.
4. **Evaluators never touch the database.** They receive a `RunObservation` projection and a
   validated config; persistence belongs to the service layer.
5. **All LLM access goes through the gateway.** A judge is a call through
   `@/modules/llm`, never a provider SDK, and its usage is accounted separately from the run
   it judges.
