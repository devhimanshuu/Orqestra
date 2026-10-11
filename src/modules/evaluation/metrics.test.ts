import { describe, expect, it } from "vitest";
import { computeBatchMetrics, computeRunMetrics, median, percentile, type RunMetricRow } from "./metrics";
import { makeResult } from "./testing/fixtures";
import type { PricedUsage } from "./pricing";

const geminiUsage: PricedUsage = {
  provider: "gemini",
  model: "gemini-2.0-flash",
  promptTokens: 1_000_000,
  completionTokens: 1_000_000,
};

function makeRun(overrides: Partial<RunMetricRow> = {}): RunMetricRow {
  return {
    status: "SUCCEEDED",
    latencyMs: 1_000,
    totalTokens: 100,
    attempt: 1,
    stepCount: 3,
    toolCalls: 1,
    modelCalls: 2,
    usage: [geminiUsage],
    evaluationScore: null,
    evaluationPassed: null,
    ...overrides,
  };
}

describe("computeRunMetrics", () => {
  it("counts statuses and computes success/failure rates", () => {
    const metrics = computeRunMetrics([
      makeRun(),
      makeRun(),
      makeRun({ status: "FAILED" }),
      makeRun({ status: "CANCELLED" }),
      makeRun({ status: "RUNNING" }),
      makeRun({ status: "QUEUED" }),
    ]);
    expect(metrics.total).toBe(6);
    expect(metrics.succeeded).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.running).toBe(1);
    expect(metrics.queued).toBe(1);
    // Rates are over terminal runs only: 2 succeeded of 4 terminal.
    expect(metrics.successRate).toBeCloseTo(0.5);
    expect(metrics.failureRate).toBeCloseTo(0.25);
  });

  it("returns null rates over an empty denominator instead of 0 or 1", () => {
    const metrics = computeRunMetrics([makeRun({ status: "RUNNING" })]);
    expect(metrics.successRate).toBeNull();
    expect(metrics.failureRate).toBeNull();
  });

  it("computes average, median and p95 latency, skipping runs that never started", () => {
    const metrics = computeRunMetrics([
      makeRun({ latencyMs: 100 }),
      makeRun({ latencyMs: 200 }),
      makeRun({ latencyMs: 300 }),
      makeRun({ latencyMs: null }),
    ]);
    expect(metrics.latency.averageMs).toBe(200);
    expect(metrics.latency.medianMs).toBe(200);
    expect(metrics.latency.p95Ms).toBe(300);
    expect(metrics.latency.measured).toBe(3);
  });

  it("reports how many runs actually reported token usage", () => {
    const metrics = computeRunMetrics([
      makeRun({ totalTokens: 100 }),
      makeRun({ totalTokens: 50 }),
      makeRun({ totalTokens: null }),
    ]);
    expect(metrics.tokens.total).toBe(150);
    expect(metrics.tokens.reported).toBe(2);
    expect(metrics.tokens.unreported).toBe(1);
  });

  it("estimates cost from usage and marks it as an estimate", () => {
    const metrics = computeRunMetrics([makeRun()]);
    // 1M prompt @ $0.10 + 1M completion @ $0.40
    expect(metrics.cost.costUsd).toBeCloseTo(0.5, 6);
    expect(metrics.cost.complete).toBe(true);
    expect(metrics.cost.billedNote).toBe("estimated");
    expect(metrics.cost.sources.join(" ")).toMatch(/list prices/);
  });

  it("refuses to produce a total when a model has no price", () => {
    const metrics = computeRunMetrics([
      makeRun({ usage: [{ provider: "mystery", model: "unpriced-1", promptTokens: 10, completionTokens: 10 }] }),
      makeRun(),
    ]);
    expect(metrics.cost.costUsd).toBeNull();
    expect(metrics.cost.complete).toBe(false);
    expect(metrics.cost.unpriced).toEqual(["mystery:unpriced-1"]);
  });

  it("counts retries, tool calls and steps, and aggregates evaluation scores", () => {
    const metrics = computeRunMetrics([
      makeRun({ attempt: 3, toolCalls: 2, stepCount: 5 }),
      makeRun({ evaluationScore: 0.8, evaluationPassed: true }),
      makeRun({ evaluationScore: 0.4, evaluationPassed: false }),
    ]);
    expect(metrics.retries).toBe(2);
    expect(metrics.toolInvocations).toBe(4);
    expect(metrics.steps).toBe(11);
    expect(metrics.evaluation.scored).toBe(2);
    expect(metrics.evaluation.mean).toBeCloseTo(0.6);
    expect(metrics.evaluation.passed).toBe(1);
    expect(metrics.evaluation.failed).toBe(1);
  });

  it("returns a fully-unavailable metric set for no runs", () => {
    const metrics = computeRunMetrics([]);
    expect(metrics.total).toBe(0);
    expect(metrics.successRate).toBeNull();
    expect(metrics.cost.costUsd).toBe(0);
    expect(metrics.evaluation.mean).toBeNull();
  });
});

describe("computeBatchMetrics", () => {
  const result = (score: number, passed: boolean) =>
    makeResult({ evaluatorKey: "answer@1", evaluatorName: "Answer", normalizedScore: score, passed });

  it("summarises case statuses, scores and aggregate coverage", () => {
    const metrics = computeBatchMetrics({
      policy: "REQUIRE_ALL",
      cases: [
        { status: "COMPLETED", aggregateScore: 1, aggregateStatus: "COMPLETE", passed: true, latencyMs: 100, totalTokens: 10, attempt: 1, toolCalls: 1, usage: [geminiUsage], results: [result(1, true)] },
        { status: "COMPLETED", aggregateScore: 0, aggregateStatus: "COMPLETE", passed: false, latencyMs: 300, totalTokens: 20, attempt: 1, toolCalls: 0, usage: [geminiUsage], results: [result(0, false)] },
        { status: "FAILED", aggregateScore: null, aggregateStatus: "FAILED", passed: null, latencyMs: null, totalTokens: null, attempt: 2, toolCalls: 0, usage: [], results: [] },
        { status: "PENDING", aggregateScore: null, aggregateStatus: null, passed: null, latencyMs: null, totalTokens: null, attempt: 0, toolCalls: 0, usage: [], results: [] },
      ],
    });

    expect(metrics.cases).toEqual({ total: 4, completed: 2, failed: 1, skipped: 0, cancelled: 0, pending: 1, running: 0 });
    expect(metrics.scored).toBe(2);
    expect(metrics.unscored).toBe(2);
    expect(metrics.aggregateStatuses.complete).toBe(2);
    expect(metrics.aggregateStatuses.failed).toBe(1);
    expect(metrics.score.mean).toBeCloseTo(0.5);
    expect(metrics.passRate).toBeCloseTo(0.5);
    expect(metrics.latency.averageMs).toBe(200);
    expect(metrics.tokens.reported).toBe(2);
    expect(metrics.tokens.unreported).toBe(2);
    expect(metrics.retries).toBe(1);
    expect(metrics.toolInvocations).toBe(1);
  });

  it("rolls up per-evaluator accuracy and separates errors from skips", () => {
    const metrics = computeBatchMetrics({
      policy: "REQUIRE_ALL",
      cases: [
        {
          status: "COMPLETED",
          aggregateScore: 1,
          aggregateStatus: "INCOMPLETE",
          passed: null,
          latencyMs: null,
          totalTokens: null,
          attempt: 1,
          toolCalls: 0,
          usage: [],
          results: [
            result(1, true),
            makeResult({ evaluatorKey: "judge@1", evaluatorName: "Judge", kind: "llm_judge", status: "ERROR", score: null, normalizedScore: null, passed: null }),
            makeResult({ evaluatorKey: "format@1", evaluatorName: "Format", kind: "json_schema", status: "SKIPPED", score: null, normalizedScore: null, passed: null }),
          ],
        },
      ],
    });

    const byKey = new Map(metrics.perEvaluator.map((entry) => [entry.evaluatorKey, entry]));
    expect(byKey.get("answer@1")).toMatchObject({ scored: 1, errors: 0, skipped: 0, meanScore: 1, passRate: 1 });
    expect(byKey.get("judge@1")).toMatchObject({ scored: 0, errors: 1, skipped: 0, meanScore: null });
    expect(byKey.get("format@1")).toMatchObject({ scored: 0, errors: 0, skipped: 1 });
    expect(metrics.aggregateStatuses.incomplete).toBe(1);
  });

  it("returns null rates and means for an empty batch", () => {
    const metrics = computeBatchMetrics({ policy: "IGNORE_MISSING", cases: [] });
    expect(metrics.score.mean).toBeNull();
    expect(metrics.passRate).toBeNull();
    expect(metrics.latency.averageMs).toBeNull();
    expect(metrics.perEvaluator).toEqual([]);
    expect(metrics.cost.costUsd).toBe(0);
  });
});

describe("helpers", () => {
  it("computes percentiles and medians defensively", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
