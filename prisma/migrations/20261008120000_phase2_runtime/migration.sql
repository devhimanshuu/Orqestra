-- Phase 2: agent runtime & execution engine persistence.
--
-- Additive only: existing runs/steps keep their data. New columns are nullable
-- (or defaulted), so a Phase 0/1 row remains readable by the Phase 2 code.

-- Run: runtime provenance, retry chain, cancellation intent.
ALTER TABLE "Run"
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "retryOfRunId" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);

CREATE INDEX "Run_agentId_createdAt_idx" ON "Run"("agentId", "createdAt");

-- RunStep: executor metadata + loop iteration.
ALTER TABLE "RunStep"
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "iteration" INTEGER;

-- Full ordered event stream per run (steps keep a per-step Trace document).
CREATE TABLE "RuntimeEvent" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeEvent_runId_seq_key" ON "RuntimeEvent"("runId", "seq");
CREATE INDEX "RuntimeEvent_runId_type_idx" ON "RuntimeEvent"("runId", "type");

ALTER TABLE "RuntimeEvent"
  ADD CONSTRAINT "RuntimeEvent_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Provider-independent usage aggregation: one row per (run, provider, model).
CREATE TABLE "UsageRecord" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "calls" INTEGER NOT NULL DEFAULT 0,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageRecord_runId_provider_model_key" ON "UsageRecord"("runId", "provider", "model");
CREATE INDEX "UsageRecord_runId_idx" ON "UsageRecord"("runId");

ALTER TABLE "UsageRecord"
  ADD CONSTRAINT "UsageRecord_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
