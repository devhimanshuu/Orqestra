# Experiments module (Phases 5–6)

Phase 0 fixes the vocabulary and the module boundary.

## What will live here

- `experiment.service.ts` — create experiments from version-pinned variants,
  assign runs to variants, aggregate scores
- Statistical comparison of variants (the primary metric + confidence
  intervals) consumed by the experiment UI
- Promotion flow: a winning variant becomes the harness's current version —
  still through the immutable `HarnessVersion` path

## Dependencies it will build on

- `@/modules/runtime` run model (`Run` pins `harnessVersionId`)
- `@/modules/evaluation` scores
- `@/modules/harness` versioning (publish + content hashes)

## Why it is not implemented in Phase 0

Experiments require runs, traces, and evaluations to exist first. The
`ExperimentVariant` shape in [`experiment.types.ts`](./experiment.types.ts) is
deliberately version-pinned so A/B comparisons cannot silently drift when a
harness is edited.
