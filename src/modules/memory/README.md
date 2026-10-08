# Memory module (not implemented in Phase 0)

Memory is intentionally **not** part of the Phase 0 foundation. This directory
exists to reserve the module boundary so the memory system can land without
reshaping the app.

## What will live here

- `MemoryStore` interface — read/write/forget entries scoped to a harness node's
  declared scope (`step`, `run`, `session`, `persistent`)
- Short-term memory (per run/session) backed by Redis
- Long-term memory (persistent) backed by PostgreSQL, with pgvector embeddings
  added by migration — the docker image and Json columns are already prepared
  for this
- Retrieval strategies (recency, similarity, hybrid) consumed by the
  `memory` harness node type

## What exists today

- The `memory` **node type** in the harness DSL (`src/modules/harness/harness.schema.ts`)
  with its scope/maxItems configuration
- Redis as a first-class dependency of the platform (`src/lib/redis`)

## Boundaries to preserve

- Tools access memory through the deterministic tool registry, never directly
- No module outside `memory/` may import a vector store client
