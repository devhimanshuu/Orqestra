import { describe, expect, it } from "vitest";
import { rankEntries } from "./experiment.ranking";
import { computeCandidateMetrics, type CandidateMetrics } from "./experiment.metrics";
import {
  EMPTY_EXPERIMENT_CONSTRAINTS,
  type ExperimentConstraints,
  type ExperimentObjective,
} from "./experiment.types";

/**
 * The ranking engine is the part of an experiment that decides who "wins". Its
 * rules are asserted here so a future change cannot quietly break them:
 *
 *  - a constraint violation outranks nothing, however good the primary metric;
 *  - an unmeasured constraint blocks a win (it never passes silently);
 *  - incomplete evidence blocks a win;
 *  - the baseline competes and can legitimately be the leader;
 *  - ties are broken by the secondary metrics, then by label.
 */

function metrics(overrides: Partial<CandidateMetrics> & { candidateId: string; label: string; role?: CandidateMetrics["role"] }): CandidateMetrics {
  return {
    ...computeCandidateMetrics({
      candidateId: overrides.candidateId,
      label: overrides.label,
      role: overrides.role ?? "CANDIDATE",
      harnessVersionId: `hv-${overrides.candidateId}`,
      harnessVersion: 1,
      policy: "REQUIRE_ALL",
      plannedExecutions: 0,
      rows: [],
    }),
    // A candidate that has actually produced evidence: without scored
    // executions the ranking refuses to rank anyone, which is a different test.
    executions: 10,
    caseCount: 10,
    scored: 10,
    ...overrides,
  };
}

const objective: ExperimentObjective = {
  primary: { metric: "evaluation_score", direction: "maximize" },
  secondary: [{ metric: "median_latency_ms", direction: "minimize" }],
  notes: null,
};

function rank(input: {
  candidates: CandidateMetrics[];
  objective?: ExperimentObjective;
  constraints?: ExperimentConstraints;
  status?: "COMPLETED" | "RUNNING";
}) {
  return rankEntries({
    objective: input.objective ?? objective,
    constraints: input.constraints ?? EMPTY_EXPERIMENT_CONSTRAINTS,
    status: input.status ?? "COMPLETED",
    baselineCandidateId: "base",
    entries: input.candidates.map((candidate) => ({ metrics: candidate, analysis: null })),
  });
}

describe("rankEntries", () => {
  it("ranks by the primary metric when nothing blocks a win", () => {
    const ranking = rank({
      candidates: [
        metrics({ candidateId: "base", label: "Baseline", role: "BASELINE", score: { mean: 0.5, median: 0.5 } }),
        metrics({ candidateId: "cand", label: "Critic loop", score: { mean: 0.8, median: 0.8 } }),
      ],
    });
    expect(ranking.candidates[0]?.metrics.candidateId).toBe("cand");
    expect(ranking.candidates[0]?.rank).toBe(1);
    expect(ranking.leader?.candidateId).toBe("cand");
    expect(ranking.leader?.statisticalSupport).toBe(false);
    expect(ranking.settled).toBe(true);
  });

  it("never ranks a constraint violation above an eligible candidate", () => {
    const constraints: ExperimentConstraints = { ...EMPTY_EXPERIMENT_CONSTRAINTS, maxMedianLatencyMs: 1_000 };
    const ranking = rank({
      constraints,
      candidates: [
        // Better primary metric, but far slower than the ceiling allows.
        metrics({
          candidateId: "cand",
          label: "Fast on paper",
          score: { mean: 0.9, median: 0.9 },
          latency: { averageMs: 9_000, medianMs: 9_000, p95Ms: 9_000, measured: 10 },
        }),
        metrics({
          candidateId: "base",
          label: "Baseline",
          role: "BASELINE",
          score: { mean: 0.5, median: 0.5 },
          latency: { averageMs: 800, medianMs: 800, p95Ms: 900, measured: 10 },
        }),
      ],
    });
    const violating = ranking.candidates.find((entry) => entry.metrics.candidateId === "cand");
    expect(violating?.constraints.violated).toBe(1);
    expect(violating?.eligibleForWin).toBe(false);
    expect(violating?.rank).toBeNull();
    expect(violating?.winBlockers[0]).toContain("9000");
    // The baseline wins by default: nothing else is eligible.
    expect(ranking.leader?.candidateId).toBe("base");
  });

  it("treats an unmeasured constraint as a win blocker, not as a pass", () => {
    const constraints: ExperimentConstraints = { ...EMPTY_EXPERIMENT_CONSTRAINTS, maxTotalCostUsd: 1 };
    const ranking = rank({
      constraints,
      candidates: [
        metrics({
          candidateId: "cand",
          label: "Unpriced",
          score: { mean: 0.9, median: 0.9 },
          cost: { costUsd: null, complete: false, unpriced: ["openai:gpt-5"], sources: [], kind: "estimated", billedNote: "estimated" },
        }),
      ],
    });
    const entry = ranking.candidates[0];
    expect(entry?.constraints.violated).toBe(0);
    expect(entry?.constraints.unknown).toBe(1);
    expect(entry?.eligibleForWin).toBe(false);
    expect(entry?.winBlockers.some((blocker) => blocker.includes("cannot be judged"))).toBe(true);
  });

  it("blocks a win while executions are outstanding and declares no leader", () => {
    const ranking = rank({
      status: "RUNNING",
      candidates: [
        metrics({ candidateId: "cand", label: "Partial", score: { mean: 0.9, median: 0.9 }, pending: 3 }),
      ],
    });
    expect(ranking.settled).toBe(false);
    expect(ranking.leader).toBeNull();
    expect(ranking.candidates[0]?.eligibleForWin).toBe(false);
    expect(ranking.notes.some((note) => note.includes("3 execution(s)"))).toBe(true);
  });

  it("blocks a win for a candidate with no scored execution", () => {
    const ranking = rank({
      candidates: [metrics({ candidateId: "cand", label: "All failed", scored: 0, unscored: 5 })],
    });
    expect(ranking.candidates[0]?.eligibleForWin).toBe(false);
    expect(ranking.candidates[0]?.winBlockers).toContain(
      "No execution of this candidate produced an aggregate score.",
    );
    expect(ranking.leader).toBeNull();
    expect(ranking.notes.some((note) => note.includes("No candidate satisfies"))).toBe(true);
  });

  it("says the baseline is leading when nothing beat it", () => {
    const ranking = rank({
      candidates: [
        metrics({ candidateId: "base", label: "Baseline", role: "BASELINE", score: { mean: 0.9, median: 0.9 } }),
        metrics({ candidateId: "cand", label: "Candidate", score: { mean: 0.4, median: 0.4 } }),
      ],
    });
    expect(ranking.leader?.candidateId).toBe("base");
    expect(ranking.leaderNote).toContain("no candidate improved it");
  });

  it("does not name a leader until the experiment is terminal", () => {
    const running = rank({
      status: "RUNNING",
      candidates: [
        metrics({ candidateId: "base", label: "Baseline", role: "BASELINE", score: { mean: 0.5, median: 0.5 } }),
        metrics({ candidateId: "cand", label: "Candidate", score: { mean: 0.8, median: 0.8 } }),
      ],
    });
    expect(running.leader).toBeNull();
    expect(running.settled).toBe(false);
    expect(running.notes.some((note) => note.includes("No winner is declared"))).toBe(true);
  });

  it("breaks a tie with the configured secondary metric, then with the label", () => {
    const ranking = rank({
      candidates: [
        metrics({
          candidateId: "cand-b",
          label: "B",
          score: { mean: 0.8, median: 0.8 },
          latency: { averageMs: 5_000, medianMs: 5_000, p95Ms: 5_000, measured: 5 },
        }),
        metrics({
          candidateId: "cand-a",
          label: "A",
          score: { mean: 0.8, median: 0.8 },
          latency: { averageMs: 900, medianMs: 900, p95Ms: 900, measured: 5 },
        }),
      ],
    });
    // Same primary score; the lower median latency (minimized) wins.
    expect(ranking.candidates[0]?.metrics.candidateId).toBe("cand-a");
    expect(ranking.candidates[1]?.metrics.candidateId).toBe("cand-b");
  });

  it("orders by a minimized primary metric when the objective says so", () => {
    const costObjective: ExperimentObjective = {
      primary: { metric: "estimated_cost_usd", direction: "minimize" },
      secondary: [],
      notes: null,
    };
    const ranking = rank({
      objective: costObjective,
      candidates: [
        metrics({
          candidateId: "expensive",
          label: "Expensive",              cost: { costUsd: 2, complete: true, unpriced: [], sources: [], kind: "estimated", billedNote: "estimated" },
        }),
        metrics({
          candidateId: "cheap",
          label: "Cheap",              cost: { costUsd: 0.2, complete: true, unpriced: [], sources: [], kind: "estimated", billedNote: "estimated" },
        }),
      ],
    });
    expect(ranking.candidates[0]?.metrics.candidateId).toBe("cheap");
  });

  it("quotes the ranking reason for each candidate", () => {
    const ranking = rank({
      candidates: [metrics({ candidateId: "cand", label: "Candidate", score: { mean: 0.8, median: 0.8 } })],
    });
    expect(ranking.candidates[0]?.reasons[0]).toContain("Mean evaluation score");
  });

  it("notes that a list-level ranking made no statistical claim", () => {
    const ranking = rank({
      candidates: [metrics({ candidateId: "cand", label: "Candidate", score: { mean: 0.8, median: 0.8 } })],
    });
    expect(ranking.notes.some((note) => note.includes("stored metrics only"))).toBe(true);
  });
});
