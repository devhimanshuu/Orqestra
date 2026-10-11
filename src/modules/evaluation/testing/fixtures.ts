/**
 * Test fixtures for the evaluation domain.
 *
 * Small factories instead of big literals: each test states only the field it
 * cares about, and a change to the observation shape is fixed in one place.
 */

import type {
  EvaluationResultRecord,
  ObservedStep,
  RunObservation,
} from "../evaluation.types";

export function makeStep(overrides: Partial<ObservedStep> = {}): ObservedStep {
  return {
    index: 0,
    nodeId: "node-1",
    nodeType: "model",
    nodeLabel: "Answer",
    status: "SUCCEEDED",
    durationMs: 12,
    iteration: null,
    toolId: null,
    toolInput: null,
    input: null,
    output: null,
    error: null,
    ...overrides,
  };
}

export function makeToolStep(toolId: string, overrides: Partial<ObservedStep> = {}): ObservedStep {
  return makeStep({
    nodeType: "tool",
    nodeLabel: `Tool ${toolId}`,
    toolId,
    ...overrides,
  });
}

export function makeObservation(overrides: Partial<RunObservation> = {}): RunObservation {
  return {
    runId: "run-1",
    status: "SUCCEEDED",
    input: "What is 2 + 2?",
    output: "4",
    error: null,
    attempt: 1,
    retryOfRunId: null,
    startedAt: new Date("2026-01-01T10:00:00Z"),
    completedAt: new Date("2026-01-01T10:00:01Z"),
    latencyMs: 1_000,
    usage: [],
    usageTotal: { calls: 0, totalTokens: 0, costUsd: 0, unknownCost: false },
    metadata: null,
    steps: [makeStep()],
    ...overrides,
  };
}

export function makeResult(overrides: Partial<EvaluationResultRecord> = {}): EvaluationResultRecord {
  const status = overrides.status ?? "COMPLETED";
  return {
    evaluatorKey: "ev-1@1",
    evaluatorId: "ev-1",
    evaluatorVersion: 1,
    evaluatorName: "Evaluator",
    kind: "exact_match",
    status,
    score: status === "COMPLETED" ? 1 : null,
    maxScore: 1,
    normalizedScore: status === "COMPLETED" ? 1 : null,
    passed: null,
    explanation: "ok",
    evidence: null,
    durationMs: 1,
    metadata: null,
    ...overrides,
  };
}

export function makeEvaluationInput(overrides: Parameters<typeof buildInput>[0] = {}) {
  return buildInput(overrides);
}

function buildInput(overrides: {
  observation?: Partial<RunObservation>;
  output?: unknown;
  /** `null` explicitly means "there is no reference answer". */
  expectedOutput?: unknown;
}) {
  const observation = makeObservation(overrides.observation ?? {});
  return {
    run: observation,
    output: overrides.output !== undefined ? overrides.output : observation.output,
    task: observation.input,
    expectedOutput: overrides.expectedOutput !== undefined ? overrides.expectedOutput : "4",
    case: null,
  };
}
