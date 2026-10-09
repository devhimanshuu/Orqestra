import { describe, expect, it } from "vitest";
import { resolvePath, resolveTemplate, resolveValue } from "./expression";
import { evaluateCondition } from "./condition";
import { ValidationError } from "../errors/runtime-error";
import type { ExpressionScope } from "./expression";

function scope(overrides: Partial<ExpressionScope> = {}): ExpressionScope {
  return {
    input: "Research AI coding agents",
    previous: { nodeId: "planner", output: { plan: ["a", "b"], stepCount: 2 } },
    variables: { score: 0.91, exhausted: false, nested: { hits: [{ url: "https://x.test" }] } },
    steps: {
      planner: { output: { plan: ["a", "b"], stepCount: 2 }, type: "planner", label: "Planner" },
      search: { output: { results: [{ title: "hit" }] }, type: "tool", label: "Search" },
    },
    run: {
      id: "run-1",
      harnessId: "harness-1",
      harnessVersionId: "version-1",
      agentId: "agent-1",
      iteration: 2,
    },
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolvePath", () => {
  it("resolves the documented namespaces", () => {
    const view = scope();
    expect(resolvePath(view, "input")).toBe("Research AI coding agents");
    expect(resolvePath(view, "previous.output.plan[1]")).toBe("b");
    expect(resolvePath(view, "planner.plan")).toEqual(["a", "b"]);
    expect(resolvePath(view, "search.results[0].title")).toBe("hit");
    expect(resolvePath(view, "state.score")).toBe(0.91);
    expect(resolvePath(view, "variables.nested.hits[0].url")).toBe("https://x.test");
    expect(resolvePath(view, "step.planner.output.stepCount")).toBe(2);
    expect(resolvePath(view, "run.iteration")).toBe(2);
    expect(resolvePath(view, "now")).toBe("2026-01-01T00:00:00.000Z");
    expect(resolvePath(view, "previous.output.plan[0]")).toBe("a");
  });

  it("returns undefined for unknown paths instead of throwing", () => {
    expect(resolvePath(scope(), "unknown.path")).toBeUndefined();
    expect(resolvePath(scope(), "planner.missing.deep")).toBeUndefined();
    expect(resolvePath(scope(), "planner.plan[9]")).toBeUndefined();
  });

  it("refuses prototype access", () => {
    expect(() => resolvePath(scope(), "__proto__.polluted")).toThrow(ValidationError);
    expect(() => resolvePath(scope(), "state.constructor.name")).toThrow(ValidationError);
  });
});

describe("resolveTemplate / resolveValue", () => {
  it("returns raw values for a lone placeholder", () => {
    expect(resolveTemplate("{{ planner.plan }}", scope())).toEqual(["a", "b"]);
    expect(resolveTemplate("{{ state.score }}", scope())).toBe(0.91);
  });

  it("interpolates mixed text and renders missing values as empty", () => {
    expect(resolveTemplate("Task: {{ input }} ({{ state.score }})", scope())).toBe(
      "Task: Research AI coding agents (0.91)",
    );
    expect(resolveTemplate("missing: [{{ nope.value }}]", scope())).toBe("missing: []");
  });

  it("deep-resolves objects and arrays (tool node inputs)", () => {
    expect(
      resolveValue({ expression: "{{ input }}", options: ["{{ state.score }}", 42] }, scope()),
    ).toEqual({ expression: "Research AI coding agents", options: [0.91, 42] });
  });
});

describe("evaluateCondition", () => {
  it("evaluates comparisons against run state", () => {
    expect(evaluateCondition("state.score >= 0.8", scope())).toMatchObject({ value: true });
    expect(evaluateCondition("state.score < 0.8", scope())).toMatchObject({ value: false });
    expect(evaluateCondition("previous.output.stepCount == 2", scope())).toMatchObject({
      value: true,
    });
    expect(evaluateCondition("variables.exhausted == false", scope())).toMatchObject({
      value: true,
    });
  });

  it("supports boolean logic, negation, strings and parentheses", () => {
    expect(evaluateCondition("state.score >= 0.5 && !variables.exhausted", scope()).value).toBe(true);
    expect(evaluateCondition("variables.exhausted || state.score > 2", scope()).value).toBe(false);
    expect(
      evaluateCondition("(state.score >= 0.9 && !variables.exhausted) || state.score > 5", scope())
        .value,
    ).toBe(true);
    expect(evaluateCondition('"a" != "b"', scope()).value).toBe(true);
    expect(evaluateCondition("null == null", scope()).value).toBe(true);
  });

  it("treats a bare path as truthy/falsy (loop guards)", () => {
    expect(evaluateCondition("state.score", scope()).value).toBe(true);
    expect(evaluateCondition("variables.missing", scope()).value).toBe(false);
  });

  it("never throws on missing data — it warns and evaluates false", () => {
    const result = evaluateCondition("state.nothing >= 0.8", scope());
    expect(result.value).toBe(false);
    expect(result.warning).toContain("missing value");
  });

  it("warns on type mismatches instead of coercing", () => {
    const result = evaluateCondition('state.score > "0.5"', scope());
    expect(result.value).toBe(false);
    expect(result.warning).toContain("type mismatch");
  });

  it("throws ValidationError for syntax errors", () => {
    expect(() => evaluateCondition("state.score >=", scope())).toThrow(ValidationError);
    expect(() => evaluateCondition("(state.score >= 1", scope())).toThrow(ValidationError);
    expect(() => evaluateCondition("state.score $ 1", scope())).toThrow(ValidationError);
    expect(() => evaluateCondition("", scope())).toThrow(ValidationError);
  });

  it("records an explanation for the trace", () => {
    expect(evaluateCondition("state.score >= 0.8", scope()).explanation).toBe(
      "state.score >= 0.8 → true",
    );
  });
});
