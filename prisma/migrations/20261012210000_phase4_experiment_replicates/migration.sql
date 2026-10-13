-- DropForeignKey
ALTER TABLE "ExperimentCandidate" DROP CONSTRAINT "ExperimentCandidate_evaluationBatchId_fkey";

-- DropIndex
DROP INDEX "ExperimentCandidate_evaluationBatchId_idx";

-- DropIndex
DROP INDEX "ExperimentRun_experimentId_candidateId_caseKey_key";

-- AlterTable
ALTER TABLE "ExperimentCandidate" DROP COLUMN "evaluationBatchId";

-- AlterTable
ALTER TABLE "ExperimentRun" ADD COLUMN     "replicate" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ExperimentCandidateReplicate" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "replicate" INTEGER NOT NULL,
    "evaluationBatchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentCandidateReplicate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExperimentCandidateReplicate_evaluationBatchId_idx" ON "ExperimentCandidateReplicate"("evaluationBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentCandidateReplicate_candidateId_replicate_key" ON "ExperimentCandidateReplicate"("candidateId", "replicate");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentRun_experimentId_candidateId_replicate_caseKey_key" ON "ExperimentRun"("experimentId", "candidateId", "replicate", "caseKey");

-- AddForeignKey
ALTER TABLE "ExperimentCandidateReplicate" ADD CONSTRAINT "ExperimentCandidateReplicate_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ExperimentCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentCandidateReplicate" ADD CONSTRAINT "ExperimentCandidateReplicate_evaluationBatchId_fkey" FOREIGN KEY ("evaluationBatchId") REFERENCES "EvaluationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

