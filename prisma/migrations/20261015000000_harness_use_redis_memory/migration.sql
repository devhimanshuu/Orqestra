-- Add useRedisMemory flag and session memory TTL to Harness
ALTER TABLE "Harness" ADD COLUMN "useRedisMemory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Harness" ADD COLUMN "sessionMemoryTtlSeconds" INTEGER;
