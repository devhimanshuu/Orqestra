-- CreateEnum
CREATE TYPE "EvaluationBatchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvaluationCaseStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvaluationResultStatus" AS ENUM ('COMPLETED', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ScoringPolicy" AS ENUM ('REQUIRE_ALL', 'IGNORE_MISSING');

-- CreateEnum
CREATE TYPE "AggregateStatus" AS ENUM ('COMPLETE', 'INCOMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetCase" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "name" TEXT,
    "input" JSONB NOT NULL,
    "expectedOutput" JSONB,
    "metadata" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatasetCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetVersion" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "cases" JSONB NOT NULL,
    "caseCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluator" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evaluator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluatorVersion" (
    "id" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluatorVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationBatch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT,
    "agentId" TEXT NOT NULL,
    "harnessId" TEXT NOT NULL,
    "harnessVersionId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "datasetVersionId" TEXT NOT NULL,
    "datasetSnapshot" JSONB NOT NULL,
    "evaluatorConfig" JSONB NOT NULL,
    "harnessSnapshot" JSONB NOT NULL,
    "scoringPolicy" "ScoringPolicy" NOT NULL DEFAULT 'REQUIRE_ALL',
    "passThreshold" DOUBLE PRECISION,
    "status" "EvaluationBatchStatus" NOT NULL DEFAULT 'PENDING',
    "caseCount" INTEGER NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "config" JSONB NOT NULL,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationCaseResult" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT,
    "status" "EvaluationCaseStatus" NOT NULL DEFAULT 'PENDING',
    "runId" TEXT,
    "inputPreview" TEXT,
    "expectedOutput" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aggregateScore" DOUBLE PRECISION,
    "aggregateStatus" "AggregateStatus",
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationCaseResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "caseResultId" TEXT,
    "runId" TEXT,
    "evaluatorId" TEXT,
    "evaluatorVersion" INTEGER,
    "evaluatorKey" TEXT NOT NULL,
    "evaluatorName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "EvaluationResultStatus" NOT NULL DEFAULT 'COMPLETED',
    "score" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "normalizedScore" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "explanation" TEXT,
    "evidence" JSONB,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dataset_projectId_idx" ON "Dataset"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_projectId_slug_key" ON "Dataset"("projectId", "slug");

-- CreateIndex
CREATE INDEX "DatasetCase_datasetId_idx" ON "DatasetCase"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetCase_datasetId_caseKey_key" ON "DatasetCase"("datasetId", "caseKey");

-- CreateIndex
CREATE INDEX "DatasetVersion_datasetId_contentHash_idx" ON "DatasetVersion"("datasetId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetVersion_datasetId_version_key" ON "DatasetVersion"("datasetId", "version");

-- CreateIndex
CREATE INDEX "Evaluator_projectId_idx" ON "Evaluator"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluator_projectId_slug_key" ON "Evaluator"("projectId", "slug");

-- CreateIndex
CREATE INDEX "EvaluatorVersion_evaluatorId_contentHash_idx" ON "EvaluatorVersion"("evaluatorId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluatorVersion_evaluatorId_version_key" ON "EvaluatorVersion"("evaluatorId", "version");

-- CreateIndex
CREATE INDEX "EvaluationBatch_projectId_createdAt_idx" ON "EvaluationBatch"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluationBatch_harnessVersionId_idx" ON "EvaluationBatch"("harnessVersionId");

-- CreateIndex
CREATE INDEX "EvaluationBatch_datasetId_idx" ON "EvaluationBatch"("datasetId");

-- CreateIndex
CREATE INDEX "EvaluationBatch_status_idx" ON "EvaluationBatch"("status");

-- CreateIndex
CREATE INDEX "EvaluationCaseResult_batchId_status_idx" ON "EvaluationCaseResult"("batchId", "status");

-- CreateIndex
CREATE INDEX "EvaluationCaseResult_runId_idx" ON "EvaluationCaseResult"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationCaseResult_batchId_caseKey_key" ON "EvaluationCaseResult"("batchId", "caseKey");

-- CreateIndex
CREATE INDEX "EvaluationResult_runId_idx" ON "EvaluationResult"("runId");

-- CreateIndex
CREATE INDEX "EvaluationResult_batchId_idx" ON "EvaluationResult"("batchId");

-- CreateIndex
CREATE INDEX "EvaluationResult_caseResultId_idx" ON "EvaluationResult"("caseResultId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationResult_caseResultId_evaluatorKey_key" ON "EvaluationResult"("caseResultId", "evaluatorKey");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetCase" ADD CONSTRAINT "DatasetCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetVersion" ADD CONSTRAINT "DatasetVersion_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluator" ADD CONSTRAINT "Evaluator_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluatorVersion" ADD CONSTRAINT "EvaluatorVersion_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_harnessId_fkey" FOREIGN KEY ("harnessId") REFERENCES "Harness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_harnessVersionId_fkey" FOREIGN KEY ("harnessVersionId") REFERENCES "HarnessVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationBatch" ADD CONSTRAINT "EvaluationBatch_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationCaseResult" ADD CONSTRAINT "EvaluationCaseResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EvaluationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EvaluationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_caseResultId_fkey" FOREIGN KEY ("caseResultId") REFERENCES "EvaluationCaseResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
