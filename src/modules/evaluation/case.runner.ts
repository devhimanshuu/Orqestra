import type { Logger } from "@/lib/logging/logger";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { executeRun } from "@/modules/runtime/run.executor";
import { createPendingRun, loadRunObservation } from "@/modules/runtime/run.service";
import type { DatasetCaseSnapshot } from "./dataset.types";
import type { EvaluationBatchRecord, EvaluationCaseRecord } from "./batch.types";
import type {
  AggregateScore,
  EvaluationInput,
  EvaluationResultRecord,
  RunObservation,
} from "./evaluation.types";
import { runEvaluator } from "./evaluator.registry";
import { aggregateResults } from "./scoring";
import { safeErrorMessage } from "./sanitize";

/**
 * Runs one dataset case end to end: create a run through the ordinary
 * run-creation pipeline → execute it with the ordinary runtime → score the
 * result with the pinned evaluators.
 *
 * Three deliberate behaviours:
 *
 *  - **The evaluation never throws.** A case answers with an outcome or a
 *    structured failure; the orchestrator records the failure and moves on. One
 *    broken case can never take a batch down.
 *  - **A failed agent run is still evaluated.** "The agent was wrong" is the
 *    most useful result an evaluation produces, so the run's status is passed
 *    to the evaluators as an observation rather than short-circuiting scoring.
 *  - **A cancelled run is not scored.** If the *batch* was cancelled, the case
 *    is reported as cancelled instead of being scored against an interrupted
 *    execution.
 */

export interface CaseExecutionOutcome {
  ok: true;
  runId: string;
  observation: RunObservation;
  aggregate: AggregateScore;
  results: EvaluationResultRecord[];
  durationMs: number;
}

export interface CaseExecutionFailure {
  ok: false;
  runId: string | null;
  error: {
    kind: "run_creation" | "run_execution" | "internal" | "cancelled";
    code: string;
    message: string;
    retryable: boolean;
  };
  /** Evaluator verdicts that did arrive (including ERROR rows). */
  results: EvaluationResultRecord[];
  aggregate: AggregateScore | null;
  durationMs: number;
}

export type CaseExecutionResult = CaseExecutionOutcome | CaseExecutionFailure;

export interface ExecuteCaseInput {
  batch: EvaluationBatchRecord;
  case: EvaluationCaseRecord;
  sample: DatasetCaseSnapshot;
  logger: Logger;
  /** Platform ceiling on models an evaluator may use, in milliseconds. */
  llmTimeoutMs?: number;
  /** Observed between phases; the batch's durable cancellation flag. */
  shouldCancel?: () => Promise<boolean>;
}

export async function executeEvaluationCase(input: ExecuteCaseInput): Promise<CaseExecutionResult> {
  const startedAt = Date.now();
  const { batch, sample } = input;
  const caseLogger = input.logger.child({
    batchId: batch.id,
    caseKey: sample.caseKey,
  });

  let runId: string | null = null;
  try {
    const run = await createPendingRun({
      agentId: batch.agentId,
      harnessVersionId: batch.harnessVersionId,
      input: sample.input,
      limits: batch.config.limits,
      origin: "evaluation",
      evaluationBatchId: batch.id,
      evaluationCaseKey: sample.caseKey,
    });
    runId = run.id;
    caseLogger.info("case run created", { runId });
  } catch (error) {
    // A harness that no longer compiles, a deleted version, a bad pin: this is
    // deterministic, so it is reported and never retried.
    return {
      ok: false,
      runId: null,
      error: {
        kind: "run_creation",
        code: "RUN_CREATION_FAILED",
        message: safeErrorMessage(error, "The run could not be created"),
        retryable: false,
      },
      results: [],
      aggregate: null,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    // The ordinary executor: claims the run atomically, executes, persists
    // steps/events/usage. Never throws for a failing run — only for a crash.
    const outcome = await executeRun(runId, { transport: "inline" });
    caseLogger.info("case run finished", { runId, status: outcome.status });
  } catch (error) {
    return {
      ok: false,
      runId,
      error: {
        kind: "run_execution",
        code: "RUN_EXECUTION_FAILED",
        message: safeErrorMessage(error, "The run failed to execute"),
        retryable: true,
      },
      results: [],
      aggregate: null,
      durationMs: Date.now() - startedAt,
    };
  }

  const observation = await loadRunObservation(runId);

  if (observation.status === "CANCELLED") {
    return {
      ok: false,
      runId,
      error: {
        kind: "cancelled",
        code: "CASE_CANCELLED",
        message: "The run was cancelled, so this case was not scored.",
        retryable: false,
      },
      results: [],
      aggregate: null,
      durationMs: Date.now() - startedAt,
    };
  }

  if (input.shouldCancel !== undefined && (await input.shouldCancel())) {
    return {
      ok: false,
      runId,
      error: {
        kind: "cancelled",
        code: "BATCH_CANCELLED",
        message: "The evaluation batch was cancelled while this case was running.",
        retryable: false,
      },
      results: [],
      aggregate: null,
      durationMs: Date.now() - startedAt,
    };
  }

  const evaluationInput: EvaluationInput = {
    run: observation,
    output: observation.output,
    task: observation.input,
    expectedOutput: sample.expectedOutput,
    case: {
      caseKey: sample.caseKey,
      name: sample.name,
      input: sample.input,
      expectedOutput: sample.expectedOutput,
      metadata: sample.metadata,
      tags: sample.tags,
    },
  };

  // Evaluators run sequentially on purpose: a batch's per-case cost stays
  // predictable, and a judge call cannot stampede the provider. Case-level
  // parallelism is the batch's `concurrency`.
  const results: EvaluationResultRecord[] = [];
  for (const assignment of batch.evaluatorConfig) {
    const record = await runEvaluator({
      kind: assignment.kind,
      evaluatorKey: assignment.key,
      evaluatorName: assignment.name,
      evaluatorId: assignment.evaluatorId,
      evaluatorVersion: assignment.evaluatorVersion,
      config: assignment.config,
      input: evaluationInput,
      context: {
        runId,
        caseKey: sample.caseKey,
        logger: caseLogger,
        now: () => new Date(),
        ...(assignment.usesLlm ? { llm: { gateway: getLLMGateway() } } : {}),
        ...(input.llmTimeoutMs !== undefined ? { llmTimeoutMs: input.llmTimeoutMs } : {}),
      },
    });
    results.push(record);
  }

  const aggregate = aggregateResults({
    assignments: batch.evaluatorConfig.map((assignment) => ({
      evaluatorKey: assignment.key,
      weight: assignment.weight,
    })),
    results,
    policy: batch.scoringPolicy,
    passThreshold: batch.passThreshold,
  });

  const evaluatorErrors = results.filter((result) => result.status === "ERROR");
  caseLogger.info("case evaluated", {
    runId,
    runStatus: observation.status,
    score: aggregate.score,
    status: aggregate.status,
    evaluatorErrors: evaluatorErrors.length,
  });

  return {
    ok: true,
    runId,
    observation,
    aggregate,
    results,
    durationMs: Date.now() - startedAt,
  };
}
