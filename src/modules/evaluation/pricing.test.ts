import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_PRICING_VERSION,
  clearPricingOverrides,
  estimateUsageCost,
  listPricing,
  priceFor,
  registerPricing,
} from "./pricing";

afterEach(() => {
  clearPricingOverrides();
});

describe("priceFor", () => {
  it("prices known provider/model pairs from the list price source", () => {
    const price = priceFor("gemini", "gemini-2.0-flash");
    expect(price?.inputPerMillion).toBe(0.1);
    expect(price?.outputPerMillion).toBe(0.4);
    expect(price?.source).toContain(BUILT_IN_PRICING_VERSION);
  });

  it("treats local and simulated providers as free by construction", () => {
    expect(priceFor("ollama", "llama3.1")?.inputPerMillion).toBe(0);
    expect(priceFor("mock", "deterministic")?.inputPerMillion).toBe(0);
    expect(priceFor("ollama", "anything")?.source).toMatch(/no provider billing/);
  });

  it("returns null for an unknown model instead of borrowing another price", () => {
    expect(priceFor("gemini", "gemini-9-ultra")).toBeNull();
    expect(priceFor("openai", "gpt-4o-mini")).not.toBeNull();
  });

  it("prefers a registered override", () => {
    registerPricing({
      provider: "acme",
      model: "acme-large",
      inputPerMillion: 2,
      outputPerMillion: 4,
      currency: "USD",
      source: "contracted rate (2026-01)",
    });
    expect(priceFor("acme", "acme-large")?.inputPerMillion).toBe(2);
    expect(listPricing().some((entry) => entry.source === "contracted rate (2026-01)")).toBe(true);
  });
});

describe("estimateUsageCost", () => {
  it("computes a per-model estimate", () => {
    const estimate = estimateUsageCost([
      { provider: "gemini", model: "gemini-2.0-flash", promptTokens: 500_000, completionTokens: 250_000 },
    ]);
    // 0.5M * 0.1 + 0.25M * 0.4 = 0.05 + 0.1
    expect(estimate.costUsd).toBeCloseTo(0.15, 6);
    expect(estimate.complete).toBe(true);
    expect(estimate.kind).toBe("estimated");
  });

  it("prefers a stored cost over re-deriving it", () => {
    const estimate = estimateUsageCost([
      { provider: "gemini", model: "gemini-2.0-flash", promptTokens: 1_000_000, completionTokens: 0, recordedCostUsd: 7 },
    ]);
    expect(estimate.costUsd).toBe(7);
    expect(estimate.sources.join(" ")).toMatch(/stored usage/);
  });

  it("marks the total unavailable when any record is unpriced, and names it", () => {
    const estimate = estimateUsageCost([
      { provider: "gemini", model: "gemini-2.0-flash", promptTokens: 1_000, completionTokens: 1_000 },
      { provider: "mystery", model: "ghost-1", promptTokens: 1_000, completionTokens: 1_000 },
    ]);
    expect(estimate.costUsd).toBeNull();
    expect(estimate.complete).toBe(false);
    expect(estimate.unpriced).toEqual(["mystery:ghost-1"]);
  });

  it("returns zero for no usage rather than null", () => {
    const estimate = estimateUsageCost([]);
    expect(estimate.costUsd).toBe(0);
    expect(estimate.complete).toBe(true);
  });

  it("never claims a cost is billed", () => {
    const estimate = estimateUsageCost([
      { provider: "openai", model: "gpt-4o-mini", promptTokens: 1, completionTokens: 1 },
    ]);
    expect(estimate.kind).toBe("estimated");
  });
});
