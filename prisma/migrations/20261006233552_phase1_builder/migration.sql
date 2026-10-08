-- CreateEnum
CREATE TYPE "HarnessStatus" AS ENUM ('DRAFT', 'VALID', 'INVALID', 'ARCHIVED');

-- AlterTable
ALTER TABLE "AgentVersion" ADD COLUMN     "purpose" TEXT;

-- AlterTable
ALTER TABLE "Harness" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "status" "HarnessStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "HarnessVersion" ADD COLUMN     "releaseNotes" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'VALID';

-- CreateTable
CREATE TABLE "HarnessDraft" (
    "id" TEXT NOT NULL,
    "harnessId" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarnessDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HarnessDraft_harnessId_key" ON "HarnessDraft"("harnessId");

-- CreateIndex
CREATE INDEX "Harness_agentId_idx" ON "Harness"("agentId");

-- AddForeignKey
ALTER TABLE "Harness" ADD CONSTRAINT "Harness_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarnessDraft" ADD CONSTRAINT "HarnessDraft_harnessId_fkey" FOREIGN KEY ("harnessId") REFERENCES "Harness"("id") ON DELETE CASCADE ON UPDATE CASCADE;
