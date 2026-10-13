import { describe, expect, it } from "vitest";
import {
  aggregateCaseObservations,
  computeCandidateMetrics,
  computeExperimentMetrics,
  meanCaseScore,
  medianCaseScore,
  type CandidateCaseMetricRow,
} from "./experiment.metrics";
import type { DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";

/**
 * Metric aggregation is where an experiment can quietly start lying. The rules
 * asserted here are the ones that keep it honest:
 *
 *  - a failed execution is *not* a zero score (it is excluded, and counted);
 *  - a rate over zero items is null, not 0 and not 1;
 *  - tokens report how many executions actually reported usage;
 *  - with replicates, a case is only "passed" when every scored trial passed.
 */

function row(overrides: Partial<CandidateCaseMetricRow> & { caseKey: string }): CandidateCaseMetricRow {
  return {
    index: 0,
    replicate: 1,
    evaluationBatchId: "batch-1",
    caseResultId: "result-1",
    status: "COMPLETED",
    runId: "run-1",
    runStatus: "SUCCEEDED",
    aggregateScore: 0.8,
    aggregateStatus: "COMPLETE",
    passed: true,
    latencyMs: 1_000,
    totalTokens: 120,
    attempt: 1,
    toolCalls: 2,
    stepCount: 4,
    usage: [],
    error: null,
    results: [],
    ...overrides,
  };
}

function metricsFor(rows: CandidateCaseMetricRow[], plannedExecutions = rows.length) {
  return computeCandidateMetrics({
    candidateId: "cand-1",
    label: "Candidate",
    role: "CANDIDATE",
    harnessVersionId: "hv-1",
    harnessVersion: 2,
    policy: "REQUIRE_ALL",
    plannedExecutions,
    rows,
  });
}

describe("computeCandidateMetrics", () => {
  it("excludes failed executions from the score and counts them separately", () => {
    const metrics = metricsFor([
      row({ caseKey: "a", aggregateScore: 1, passed: true }),
      row({ caseKey: "b", aggregateScore: 0, passed: false }),
      row({
        caseKey: "c",
        status: "FAILED",
        runStatus: "FAILED",
        aggregateScore: null,
        passed: null,
        error: { kind: "run_execution" },
      }),
    ]);

    // The mean is over the two scored cases only — a failure is not a 0.
    expect(metrics.score.mean).toBeCloseTo(0.5, 6);
    expect(metrics.scored).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.executions).toBe(3);
  });

  it("reports null (not zero) for every rate when nothing was measured", () => {
    const metrics = metricsFor([]);
    expect(metrics.score.mean).toBeNull();
    expect(metrics.score.median).toBeNull();
    expect(metrics.passRate).toBeNull();
    expect(metrics.failureRate).toBeNull();
    expect(metrics.latency.medianMs).toBeNull();
    expect(metrics.latency.p95Ms).toBeNull();
    expect(metrics.toolCallsPerCase).toBeNull();
    expect(metrics.timeoutRate).toBeNull();
  });

  it("counts tokens from the executions that reported usage", () => {
    const metrics = metricsFor([
      row({ caseKey: "a", totalTokens: 100 }),
      row({ caseKey: "b", totalTokens: 300 }),
      row({ caseKey: "c", totalTokens: null }),
    ]);
    expect(metrics.tokens).toMatchObject({ total: 400, reported: 2, unreported: 1 });
  });

  it("derives tool calls per scored case, not per execution", () => {
    const metrics = metricsFor([
      row({ caseKey: "a", toolCalls: 4 }),
      row({ caseKey: "a", toolCalls: 6 }),
    ]);
    // Two executions of one case: 10 calls over 1 scored case.
    expect(metrics.toolInvocations).toBe(10);
    expect(metrics.toolCallsPerCase).toBeCloseTo(10, 6);
  });

  it("reports the timeout rate over terminal executions", () => {
    const metrics = metricsFor([
      row({ caseKey: "a" }),
      row({ caseKey: "b", runStatus: "TIMED_OUT", passed: null }),
    ]);
    expect(metrics.timedOut).toBe(1);
    expect(metrics.timeoutRate).toBeCloseTo(0.5, 6);
  });

  it("reports an incomplete aggregate rather than a failure", () => {
    const metrics = metricsFor([
      row({ caseKey: "a", aggregateScore: null, aggregateStatus: "INCOMPLETE", passed: null }),
    ]);
    expect(metrics.incomplete).toBe(1);
    expect(metrics.unscored).toBe(1);
    expect(metrics.score.mean).toBeNull();
  });

  it("computes the p95 latency from the measured executions", () => {
    const metrics = metricsFor([
      row({ caseKey: "a", latencyMs: 100 }),
      row({ caseKey: "b", latencyMs: 200 }),
      row({ caseKey: "c", latencyMs: 300 }),
      row({ caseKey: "d", latencyMs: 1_000 }),
      row({ caseKey: "e", latencyMs: 2_000 }),
    ]);
    expect(metrics.latency.medianMs).toBe(300);
    expect(metrics.latency.p95Ms).toBe(2_000);
  });
});

function sample(key: string, overrides: Partial<DatasetCaseSnapshot> = {}): DatasetCaseSnapshot {
  return {
    caseKey: key,
    name: null,
    input: {},
    expectedOutput: null,
    metadata: null,
    tags: [],
    ...overrides,
  };
}

function observationRows(rows: CandidateCaseMetricRow[]): CandidateCaseMetricRow[] {
  return rows.map((entry, index) => ({ ...entry, index: entry.index === 0 ? index : entry.index }));
}

describe("aggregateCaseObservations", () => {
  it("projects a single trial straight onto the case", () => {
    const observations = aggregateCaseObservations({
      samples: [sample("a")],
      rows: observationRows([row({ caseKey: "a", aggregateScore: 0.9, passed: true })]),
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.meanScore).toBeCloseTo(0.9, 6);
    expect(observations[0]?.passed).toBe(true);
    expect(observations[0]?.scoredTrials).toBe(1);
  });

  it("averages replicates and requires every scored trial to pass", () => {
    const observations = aggregateCaseObservations({
      samples: [sample("a")],
      rows: [
        row({ caseKey: "a", replicate: 1, aggregateScore: 1, passed: true }),
        row({ caseKey: "a", replicate: 2, aggregateScore: 0.4, passed: false }),
      ],
    });
    expect(observations[0]?.meanScore).toBeCloseTo(0.7, 6);
    // The conservative reading: a candidate that is right once in two attempts
    // does not look as good as one that is right every time.
    expect(observations[0]?.passed).toBe(false);
    expect(observations[0]?.scoredTrials).toBe(2);
    expect(observations[0]?.trials.map((trial) => trial.replicate)).toEqual([1, 2]);
  });

  it("passes a case when an unscored trial does not contradict the scored one", () => {
    const observations = aggregateCaseObservations({
      samples: [sample("a")],
      rows: [
        row({ caseKey: "a", replicate: 1, aggregateScore: 1, passed: true }),
        row({
          caseKey: "a",
          replicate: 2,
          status: "FAILED",
          runStatus: "FAILED",
          aggregateScore: null,
          passed: null,
        }),
      ],
    });
    expect(observations[0]?.passed).toBe(true);
    expect(observations[0]?.scoredTrials).toBe(1);
    expect(observations[0]?.meanScore).toBe(1);
  });

  it("reports a case with no verdict as unmeasured, not as failed", () => {
    const observations = aggregateCaseObservations({
      samples: [sample("a")],
      rows: observationRows([
        row({ caseKey: "a", status: "PENDING", runId: null, runStatus: null, aggregateScore: null, passed: null }),
      ]),
    });
    expect(observations[0]?.passed).toBeNull();
    expect(observations[0]?.meanScore).toBeNull();
  });

  it("keeps cases that never ran so alignment stays stable", () => {
    const observations = aggregateCaseObservations({ samples: [sample("a"), sample("b")], rows: [] });
    expect(observations.map((entry) => entry.caseKey)).toEqual(["a", "b"]);
  });
});

describe("score helpers", () => {
  it("computes the mean and median of per-case scores, ignoring unscored cases", () => {
    const observations = aggregateCaseObservations({
      samples: [sample("a"), sample("b"), sample("c")],
      rows: [
        row({ caseKey: "a", aggregateScore: 1, passed: true }),
        row({ caseKey: "b", aggregateScore: 0.5, passed: false }),
        row({
          caseKey: "c",
          status: "FAILED",
          runStatus: "FAILED",
          aggregateScore: null,
          passed: null,
        }),
      ],
    });
    expect(meanCaseScore(observations)).toBeCloseTo(0.75, 6);
    expect(medianCaseScore(observations)).toBeCloseTo(0.75, 6);
  });
});

describe("computeExperimentMetrics", () => {
  it("sums the counts of every candidate and flags completeness", () => {
    const inputs = [
      {
        candidateId: "cand-1",
        label: "A",
        role: "CANDIDATE" as const,
        harnessVersionId: "hv-1",
        harnessVersion: 1,
        policy: "REQUIRE_ALL" as const,
        plannedExecutions: 2,
        rows: [row({ caseKey: "a" }), row({ caseKey: "b" })],
      },
      {
        candidateId: "cand-2",
        label: "B",
        role: "BASELINE" as const,
        harnessVersionId: "hv-2",
        harnessVersion: 1,
        policy: "REQUIRE_ALL" as const,
        plannedExecutions: 2,
        rows: [
          row({ caseKey: "a", aggregateScore: null, status: "FAILED", runStatus: "FAILED", passed: null }),
          row({ caseKey: "b", status: "PENDING", runId: null, runStatus: null, aggregateScore: null, passed: null }),
        ],
      },
    ];
    const metrics = computeExperimentMetrics({
      plannedExecutions: 4,
      caseCount: 2,
      policy: "REQUIRE_ALL",
      candidates: inputs,
    });
    expect(metrics.candidates).toHaveLength(2);
    expect(metrics.completed).toBe(2);
    expect(metrics.failed).toBe(1);
    // The second candidate still has one case to execute.
    expect(metrics.pending).toBe(1);
    expect(metrics.complete).toBe(false);
  });
});
