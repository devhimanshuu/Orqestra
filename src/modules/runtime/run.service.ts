import { logger } from "@/lib/logging/logger";
import { HarnessNotFoundError, HarnessValidationError } from "@/modules/harness/harness.types";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { compileHarness } from "./compiler";
import { enqueueRun } from "./queues";
import { runRepository } from "./run.repository";
import type { CreateRunInput, Run, RunWithSteps } from "./run.types";
import { RunNotFoundError } from "./run.types";

/**
 * Run service.
 *
 * Enqueue-time guarantees:
 *  - the harness version exists and its definition still compiles (a run can
 *    never be queued for an unexecutable harness)
 *  - the Run row is created before the job is enqueued, so the queue payload
 *    always references durable state
 *  - nothing heavy happens in the request: execution is a worker concern
 */

export async function createRun(input: CreateRunInput): Promise<Run> {
  const harnessVersion = await harnessRepository.findVersionById(input.harnessVersionId);
  if (harnessVersion === null) {
    throw new HarnessNotFoundError(input.harnessVersionId);
  }

  const compiled = compileHarness(harnessVersion.definition);
  if (!compiled.ok) {
    throw new HarnessValidationError(compiled.issues);
  }

  const run = await runRepository.create({
    harnessId: harnessVersion.harnessId,
    harnessVersionId: harnessVersion.id,
    input: input.input,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
  });

  await enqueueRun({ runId: run.id, harnessVersionId: harnessVersion.id });

  logger.info("run created", {
    runId: run.id,
    harnessId: harnessVersion.harnessId,
    harnessVersion: harnessVersion.version,
  });
  return run;
}

export async function getRun(runId: string): Promise<RunWithSteps> {
  const run = await runRepository.findByIdWithSteps(runId);
  if (run === null) {
    throw new RunNotFoundError(runId);
  }
  return run;
}

export async function listRunsForHarness(harnessId: string, limit = 20): Promise<RunWithSteps[]> {
  return runRepository.listByHarness(harnessId, limit);
}
