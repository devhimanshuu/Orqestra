-- Add useRedisMemory flag to Harness
ALTER TABLE "Harness" ADD COLUMN "useRedisMemory" BOOLEAN NOT NULL DEFAULT false;
