/**
 * Cost accounting.
 *
 * Two rules, both non-negotiable:
 *
 *  1. **A price is data, never an assumption.** Every entry carries the source
 *     it came from, and a provider/model with no entry yields `null` — never a
 *     guessed price, and never the same price as some other model.
 *  2. **Estimated is not billed.** Orqestra has no billing integration, so every
 *     number this module produces is labelled `estimated`. Actual billed cost
 *     would come from a provider invoice; until that exists, the UI must say
 *     "estimated".
 *
 * The execution-time estimate the runtime records on `UsageRecord.costUsd` uses
 * the same public list prices (see runtime/usage/tracker.ts). This module is the
 * *accounting* view: it can re-derive a cost for records that were stored
 * without one, it aggregates per provider/model, and it always names its source.
 */

export interface PricingEntry {
  provider: string;
  /** Model id as it appears after the ":" in a model reference. */
  model: string;
  /** USD per 1M prompt (input) tokens. */
  inputPerMillion: number;
  /** USD per 1M completion (output) tokens. */
  outputPerMillion: number;
  currency: "USD";
  /** Where the price came from — displayed next to every estimate. */
  source: string;
}

/** Version tag for the built-in price list, recorded on every estimate. */
export const BUILT_IN_PRICING_VERSION = "orqestra-builtin-list-prices@2026-10";

const LIST_PRICE_SOURCE = `${BUILT_IN_PRICING_VERSION} (public list prices)`;

const ENTRIES: PricingEntry[] = [
  { provider: "gemini", model: "gemini-2.0-flash", inputPerMillion: 0.1, outputPerMillion: 0.4, currency: "USD", source: LIST_PRICE_SOURCE },
  { provider: "gemini", model: "gemini-2.5-pro", inputPerMillion: 1.25, outputPerMillion: 10, currency: "USD", source: LIST_PRICE_SOURCE },
  { provider: "openai", model: "gpt-4o-mini", inputPerMillion: 0.15, outputPerMillion: 0.6, currency: "USD", source: LIST_PRICE_SOURCE },
  { provider: "anthropic", model: "claude-sonnet-4", inputPerMillion: 3, outputPerMillion: 15, currency: "USD", source: LIST_PRICE_SOURCE },
  { provider: "groq", model: "llama-3.3-70b-versatile", inputPerMillion: 0.59, outputPerMillion: 0.79, currency: "USD", source: LIST_PRICE_SOURCE },
  // Local/runtime-owned providers are free by construction, not by list price.
  { provider: "ollama", model: "*", inputPerMillion: 0, outputPerMillion: 0, currency: "USD", source: "local runtime — no provider billing" },
  { provider: "mock", model: "*", inputPerMillion: 0, outputPerMillion: 0, currency: "USD", source: "deterministic simulator — no provider billing" },
];

const TABLE = new Map<string, PricingEntry>(ENTRIES.map((entry) => [`${entry.provider}:${entry.model}`, entry]));

/** Extra prices supplied at runtime (tests, deployments with negotiated rates). */
const overrides = new Map<string, PricingEntry>();

export function registerPricing(entry: PricingEntry): void {
  overrides.set(`${entry.provider}:${entry.model}`, entry);
}

export function clearPricingOverrides(): void {
  overrides.clear();
}

export function priceFor(provider: string, model: string): PricingEntry | null {
  return overrides.get(`${provider}:${model}`) ?? TABLE.get(`${provider}:${model}`) ?? TABLE.get(`${provider}:*`) ?? null;
}

/** Every price the platform knows, for the pricing transparency panel. */
export function listPricing(): PricingEntry[] {
  return [...overrides.values(), ...ENTRIES];
}

export interface CostEstimate {
  /** Null when any contributing call had no price. */
  costUsd: number | null;
  /** True when every contributing call was priced. */
  complete: boolean;
  /** Providers/models that could not be priced, e.g. ["gemini:gemini-9"]. */
  unpriced: string[];
  /** Distinct pricing sources that contributed. */
  sources: string[];
  /** Always "estimated": Orqestra has no billing integration. */
  kind: "estimated";
}

export const UNPRICED_COST: CostEstimate = {
  costUsd: null,
  complete: false,
  unpriced: [],
  sources: [],
  kind: "estimated",
};

export interface PricedUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** A stored cost (from the run's usage record) takes precedence when present. */
  recordedCostUsd?: number | null;
}

/**
 * Estimates the cost of a set of usage records.
 *
 * A record's own `recordedCostUsd` wins when present — it was computed at
 * execution time from the same table; re-deriving it could only introduce
 * drift. Records without one are priced here, and anything unpriced makes the
 * whole estimate incomplete rather than silently partial.
 */
export function estimateUsageCost(records: readonly PricedUsage[]): CostEstimate {
  if (records.length === 0) {
    return { ...UNPRICED_COST, complete: true, costUsd: 0 };
  }

  let total = 0;
  let complete = true;
  const unpriced: string[] = [];
  const sources = new Set<string>();

  for (const record of records) {
    const key = `${record.provider}:${record.model}`;
    if (record.recordedCostUsd !== undefined && record.recordedCostUsd !== null) {
      total += record.recordedCostUsd;
      sources.add(`stored usage (${BUILT_IN_PRICING_VERSION})`);
      continue;
    }
    const price = priceFor(record.provider, record.model);
    if (price === null) {
      complete = false;
      if (!unpriced.includes(key)) {
        unpriced.push(key);
      }
      continue;
    }
    total += (record.promptTokens / 1_000_000) * price.inputPerMillion;
    total += (record.completionTokens / 1_000_000) * price.outputPerMillion;
    sources.add(price.source);
  }

  return {
    costUsd: complete ? Number(total.toFixed(8)) : null,
    complete,
    unpriced,
    sources: [...sources],
    kind: "estimated",
  };
}
