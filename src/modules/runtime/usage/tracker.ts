/**
 * Usage & cost tracking.
 *
 * Provider-independent: every node executor reports token usage in this shape,
 * and the tracker aggregates per model for the run row, the run UI, and future
 * experiments. Prices are approximate public list prices expressed in USD per
 * 1M tokens; local providers (Ollama) and the mock provider are free by
 * definition. An unknown model yields a `null` cost instead of a guess, and the
 * aggregate reports `unknownCost` so the UI can say "n/a" honestly.
 */

export interface RuntimeTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageEntry {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD; null when the model has no known price. */
  costUsd: number | null;
}

export interface UsageTotal {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  /** True when at least one model had no price — costUsd then covers priced calls only. */
  unknownCost: boolean;
}

interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Approximate list prices (USD / 1M tokens). Update deliberately: a wrong price
 * is worse than no price, which is why unknown models return null.
 */
export const MODEL_PRICE_TABLE: Record<string, ModelPrice> = {
  "gemini:gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini:gemini-2.5-pro": { input: 1.25, output: 10 },
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic:claude-sonnet-4": { input: 3, output: 15 },
  "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
};

/** Providers that never cost money regardless of model. */
const FREE_PROVIDERS = new Set(["ollama", "mock"]);

export function estimateCostUsd(
  provider: string,
  model: string,
  usage: RuntimeTokenUsage,
): number | null {
  if (FREE_PROVIDERS.has(provider)) {
    return 0;
  }
  const price = MODEL_PRICE_TABLE[`${provider}:${model}`];
  if (price === undefined) {
    return null;
  }
  const inputCost = (usage.promptTokens / 1_000_000) * price.input;
  const outputCost = (usage.completionTokens / 1_000_000) * price.output;
  return Number((inputCost + outputCost).toFixed(8));
}

export class UsageTracker {
  private readonly entries = new Map<string, UsageEntry>();

  record(input: { provider: string; model: string; usage: RuntimeTokenUsage }): UsageEntry {
    const key = `${input.provider}:${input.model}`;
    const existing = this.entries.get(key) ?? {
      provider: input.provider,
      model: input.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };

    const callCost = estimateCostUsd(input.provider, input.model, input.usage);
    const next: UsageEntry = {
      ...existing,
      calls: existing.calls + 1,
      promptTokens: existing.promptTokens + input.usage.promptTokens,
      completionTokens: existing.completionTokens + input.usage.completionTokens,
      totalTokens: existing.totalTokens + input.usage.totalTokens,
      costUsd:
        existing.costUsd === null || callCost === null
          ? null
          : Number((existing.costUsd + callCost).toFixed(8)),
    };
    this.entries.set(key, next);
    return next;
  }

  byModel(): UsageEntry[] {
    return [...this.entries.values()];
  }

  total(): UsageTotal {
    let calls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let costUsd: number | null = 0;
    let unknownCost = false;

    for (const entry of this.entries.values()) {
      calls += entry.calls;
      promptTokens += entry.promptTokens;
      completionTokens += entry.completionTokens;
      totalTokens += entry.totalTokens;
      if (entry.costUsd === null) {
        unknownCost = true;
        continue;
      }
      if (costUsd !== null) {
        costUsd = Number((costUsd + entry.costUsd).toFixed(8));
      }
    }

    return {
      calls,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: entriesAreEmpty(this.entries) ? 0 : costUsd,
      unknownCost,
    };
  }
}

function entriesAreEmpty(entries: Map<string, UsageEntry>): boolean {
  return entries.size === 0;
}
