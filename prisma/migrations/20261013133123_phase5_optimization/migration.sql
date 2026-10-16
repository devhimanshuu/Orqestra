-- CreateEnum
CREATE TYPE "OptimizationStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OptimizationStrategy" AS ENUM ('RULE_BASED', 'LLM_ASSISTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "OptimizationCandidateStatus" AS ENUM ('PROPOSED', 'VALIDATING', 'INVALID', 'EVALUATING', 'EVALUATED', 'FAILED');

-- CreateEnum
CREATE TYPE "OptimizationDecisionKind" AS ENUM ('ACCEPT', 'REJECT', 'INCONCLUSIVE');

-- CreateTable
CREATE TABLE "OptimizationSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "harnessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "OptimizationStatus" NOT NULL DEFAULT 'DRAFT',
    "strategy" "OptimizationStrategy" NOT NULL DEFAULT 'RULE_BASED',
    "baselineVersionId" TEXT NOT NULL,
    "sourceBatchId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "datasetVersionId" TEXT NOT NULL,
    "promotedCandidateId" TEXT,
    "evaluatorConfig" JSONB NOT NULL,
    "scoringPolicy" "ScoringPolicy" NOT NULL DEFAULT 'REQUIRE_ALL',
    "passThreshold" DOUBLE PRECISION,
    "objective" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "configSnapshot" JSONB,
    "currentIteration" INTEGER NOT NULL DEFAULT 0,
    "maxIterations" INTEGER NOT NULL DEFAULT 1,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "tokenUsage" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analyzerTokenUsage" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "report" JSONB,
    "bestCandidateId" TEXT,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailureFinding" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "frequency" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'high',
    "impact" TEXT,
    "investigation" TEXT,
    "isLlm" BOOLEAN NOT NULL DEFAULT false,
    "caseKeys" TEXT[],
    "runIds" TEXT[],
    "evaluatorKeys" TEXT[],
    "traceRefs" JSONB,
    "hypothesisIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailureFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImprovementHypothesis" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "findingId" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "observation" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "proposedChange" TEXT NOT NULL,
    "expectedOutcome" TEXT NOT NULL,
    "tradeoff" TEXT,
    "metricKeys" TEXT[],
    "acceptanceCriteria" JSONB,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "requiresReview" BOOLEAN NOT NULL DEFAULT true,
    "origin" "OptimizationStrategy" NOT NULL DEFAULT 'RULE_BASED',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImprovementHypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationCandidate" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "hypothesisId" TEXT,
    "label" TEXT NOT NULL,
    "draftId" TEXT,
    "versionId" TEXT,
    "contentHash" TEXT,
    "status" "OptimizationCandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "evaluationBatchId" TEXT,
    "validation" JSONB,
    "changeSet" JSONB,
    "baselineMetrics" JSONB,
    "metrics" JSONB,
    "decision" JSONB,
    "decisionKind" "OptimizationDecisionKind",
    "fingerprint" TEXT NOT NULL,
    "analyzerTokenUsage" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarnessMutation" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "risk" TEXT NOT NULL DEFAULT 'LOW',
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarnessMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationDecision" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "candidateId" TEXT,
    "kind" "OptimizationDecisionKind" NOT NULL,
    "rationale" JSONB NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ref" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OptimizationSession_projectId_createdAt_idx" ON "OptimizationSession"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "OptimizationSession_agentId_createdAt_idx" ON "OptimizationSession"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "OptimizationSession_harnessId_idx" ON "OptimizationSession"("harnessId");

-- CreateIndex
CREATE INDEX "OptimizationSession_status_idx" ON "OptimizationSession"("status");

-- CreateIndex
CREATE INDEX "FailureFinding_sessionId_category_idx" ON "FailureFinding"("sessionId", "category");

-- CreateIndex
CREATE INDEX "FailureFinding_sessionId_idx" ON "FailureFinding"("sessionId");

-- CreateIndex
CREATE INDEX "ImprovementHypothesis_sessionId_status_idx" ON "ImprovementHypothesis"("sessionId", "status");

-- CreateIndex
CREATE INDEX "ImprovementHypothesis_sessionId_category_idx" ON "ImprovementHypothesis"("sessionId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ImprovementHypothesis_sessionId_fingerprint_key" ON "ImprovementHypothesis"("sessionId", "fingerprint");

-- CreateIndex
CREATE INDEX "OptimizationCandidate_sessionId_iteration_idx" ON "OptimizationCandidate"("sessionId", "iteration");

-- CreateIndex
CREATE INDEX "OptimizationCandidate_sessionId_status_idx" ON "OptimizationCandidate"("sessionId", "status");

-- CreateIndex
CREATE INDEX "OptimizationCandidate_hypothesisId_idx" ON "OptimizationCandidate"("hypothesisId");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationCandidate_sessionId_fingerprint_key" ON "OptimizationCandidate"("sessionId", "fingerprint");

-- CreateIndex
CREATE INDEX "HarnessMutation_candidateId_idx" ON "HarnessMutation"("candidateId");

-- CreateIndex
CREATE INDEX "OptimizationDecision_sessionId_createdAt_idx" ON "OptimizationDecision"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "OptimizationDecision_candidateId_idx" ON "OptimizationDecision"("candidateId");

-- CreateIndex
CREATE INDEX "OptimizationEvent_sessionId_createdAt_idx" ON "OptimizationEvent"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_harnessId_fkey" FOREIGN KEY ("harnessId") REFERENCES "Harness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_baselineVersionId_fkey" FOREIGN KEY ("baselineVersionId") REFERENCES "HarnessVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "EvaluationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSession" ADD CONSTRAINT "OptimizationSession_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailureFinding" ADD CONSTRAINT "FailureFinding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OptimizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementHypothesis" ADD CONSTRAINT "ImprovementHypothesis_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OptimizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationCandidate" ADD CONSTRAINT "OptimizationCandidate_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "HarnessVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationCandidate" ADD CONSTRAINT "OptimizationCandidate_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OptimizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationCandidate" ADD CONSTRAINT "OptimizationCandidate_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ImprovementHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationCandidate" ADD CONSTRAINT "OptimizationCandidate_evaluationBatchId_fkey" FOREIGN KEY ("evaluationBatchId") REFERENCES "EvaluationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarnessMutation" ADD CONSTRAINT "HarnessMutation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "OptimizationCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationDecision" ADD CONSTRAINT "OptimizationDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OptimizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationDecision" ADD CONSTRAINT "OptimizationDecision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "OptimizationCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationEvent" ADD CONSTRAINT "OptimizationEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OptimizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
