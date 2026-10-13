-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExperimentCandidateRole" AS ENUM ('BASELINE', 'CANDIDATE');

-- CreateEnum
CREATE TYPE "ExperimentSelectionKind" AS ENUM ('RECOMMENDED', 'SELECTED');

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "hypothesis" TEXT,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "datasetId" TEXT NOT NULL,
    "datasetVersionId" TEXT NOT NULL,
    "datasetSnapshot" JSONB NOT NULL,
    "evaluatorConfig" JSONB NOT NULL,
    "scoringPolicy" "ScoringPolicy" NOT NULL DEFAULT 'REQUIRE_ALL',
    "passThreshold" DOUBLE PRECISION,
    "objective" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "execution" JSONB NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "plannedRunCount" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "selectedCandidateId" TEXT,
    "selectionKind" "ExperimentSelectionKind",
    "selectionNotes" TEXT,
    "selectedBy" TEXT,
    "selectedAt" TIMESTAMP(3),
    "promotedCandidateId" TEXT,
    "promotionNotes" TEXT,
    "promotedBy" TEXT,
    "promotedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentCandidate" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" "ExperimentCandidateRole" NOT NULL DEFAULT 'CANDIDATE',
    "hypothesis" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "harnessId" TEXT NOT NULL,
    "harnessVersionId" TEXT NOT NULL,
    "harnessVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "harnessSnapshot" JSONB NOT NULL,
    "evaluationBatchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentRun" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "datasetVersionId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Experiment_projectId_createdAt_idx" ON "Experiment"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Experiment_agentId_createdAt_idx" ON "Experiment"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Experiment_status_idx" ON "Experiment"("status");

-- CreateIndex
CREATE INDEX "Experiment_datasetVersionId_idx" ON "Experiment"("datasetVersionId");

-- CreateIndex
CREATE INDEX "ExperimentCandidate_experimentId_orderIndex_idx" ON "ExperimentCandidate"("experimentId", "orderIndex");

-- CreateIndex
CREATE INDEX "ExperimentCandidate_harnessVersionId_idx" ON "ExperimentCandidate"("harnessVersionId");

-- CreateIndex
CREATE INDEX "ExperimentCandidate_evaluationBatchId_idx" ON "ExperimentCandidate"("evaluationBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentCandidate_experimentId_label_key" ON "ExperimentCandidate"("experimentId", "label");

-- CreateIndex
CREATE INDEX "ExperimentRun_experimentId_orderIndex_idx" ON "ExperimentRun"("experimentId", "orderIndex");

-- CreateIndex
CREATE INDEX "ExperimentRun_candidateId_idx" ON "ExperimentRun"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentRun_experimentId_candidateId_caseKey_key" ON "ExperimentRun"("experimentId", "candidateId", "caseKey");

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentCandidate" ADD CONSTRAINT "ExperimentCandidate_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentCandidate" ADD CONSTRAINT "ExperimentCandidate_harnessId_fkey" FOREIGN KEY ("harnessId") REFERENCES "Harness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentCandidate" ADD CONSTRAINT "ExperimentCandidate_harnessVersionId_fkey" FOREIGN KEY ("harnessVersionId") REFERENCES "HarnessVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentCandidate" ADD CONSTRAINT "ExperimentCandidate_evaluationBatchId_fkey" FOREIGN KEY ("evaluationBatchId") REFERENCES "EvaluationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentRun" ADD CONSTRAINT "ExperimentRun_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentRun" ADD CONSTRAINT "ExperimentRun_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ExperimentCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
