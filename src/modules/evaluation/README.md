# Evaluation module (Phase 4)

Phase 0 fixes the vocabulary and the module boundary — nothing here touches the
database yet.

## What will live here

- `Evaluator` implementations for each `EvaluatorKind` in
  [`evaluation.types.ts`](./evaluation.types.ts): deterministic scorers
  (`exact_match`, `contains`, `regex`, `json_schema`) and `llm_judge` (which must
  go through `@/modules/llm` — never a provider SDK)
- `evaluation.service.ts` — score a `Run` against an `Evaluator`/`Dataset`,
  persist `Evaluation` rows
- Dataset handling: versioned, content-hashed inputs so evaluation results stay
  reproducible

## Why it is not implemented in Phase 0

Evaluation is only meaningful once runs produce traces (Phase 2–3) and a
dataset editor exists. Building it now would bake in assumptions that the
runtime will invalidate.
