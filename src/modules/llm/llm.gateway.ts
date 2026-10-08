import { logger } from "@/lib/logging/logger";
import {
  LLMProviderError,
  parseModelRef,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "./llm.types";
import { geminiProvider } from "./providers/gemini.provider";
import { ollamaProvider } from "./providers/ollama.provider";

/**
 * LLM Gateway — the only surface application code calls.
 *
 * Responsibilities:
 *  - registry of providers (built-ins registered lazily, custom ones via registerLLMProvider)
 *  - resolve "provider:model" refs → provider instances
 *  - uniform, structured errors (providers never leak SDK-specific failures)
 *  - latency + usage accounting for future cost tracking
 */

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
}

export interface LLMGateway {
  register(provider: LLMProvider): void;
  getProvider(providerId: string): LLMProvider;
  listProviders(): ProviderInfo[];
  generate(ref: string | ModelRefInput, request: Omit<LLMRequest, "model">): Promise<LLMResponse>;
}

export interface ModelRefInput {
  provider: string;
  model: string;
}

function toModelRef(ref: string | ModelRefInput): ModelRefInput {
  if (typeof ref === "string") {
    const parsed = parseModelRef(ref);
    if (parsed === null) {
      throw new LLMProviderError(
        "provider_error",
        "unknown",
        `Invalid model reference "${ref}" — expected "provider:model"`,
      );
    }
    return parsed;
  }
  return ref;
}

class Gateway implements LLMGateway {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly builtinsLoaded = { done: false };

  register(provider: LLMProvider): void {
    if (this.providers.has(provider.id)) {
      throw new LLMProviderError(
        "provider_error",
        provider.id,
        `Provider "${provider.id}" is already registered`,
      );
    }
    this.providers.set(provider.id, provider);
    logger.info("llm provider registered", { provider: provider.id });
  }

  private ensureBuiltins(): void {
    if (this.builtinsLoaded.done) {
      return;
    }
    this.builtinsLoaded.done = true;
    // Providers read credentials lazily (isConfigured/generate) — importing
    // them is side-effect free.
    if (!this.providers.has(geminiProvider.id)) {
      this.providers.set(geminiProvider.id, geminiProvider);
    }
    if (!this.providers.has(ollamaProvider.id)) {
      this.providers.set(ollamaProvider.id, ollamaProvider);
    }
  }

  getProvider(providerId: string): LLMProvider {
    this.ensureBuiltins();
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new LLMProviderError(
        "provider_not_configured",
        providerId,
        `No LLM provider registered for "${providerId}"`,
      );
    }
    return provider;
  }

  listProviders(): ProviderInfo[] {
    this.ensureBuiltins();
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      configured: provider.isConfigured(),
    }));
  }

  async generate(
    ref: string | ModelRefInput,
    request: Omit<LLMRequest, "model">,
  ): Promise<LLMResponse> {
    const { provider: providerId, model } = toModelRef(ref);
    const provider = this.getProvider(providerId);

    if (!provider.isConfigured()) {
      throw new LLMProviderError(
        "provider_not_configured",
        providerId,
        `Provider "${providerId}" is not configured (missing credentials or base URL)`,
      );
    }

    const startedAt = performance.now();
    try {
      const response = await provider.generate({ ...request, model });
      logger.debug("llm generate", {
        provider: providerId,
        model,
        latencyMs: Math.round(performance.now() - startedAt),
        totalTokens: response.usage.totalTokens,
      });
      return response;
    } catch (error) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        "provider_error",
        providerId,
        `Provider "${providerId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }
  }
}

let gateway: LLMGateway | null = null;

export function getLLMGateway(): LLMGateway {
  if (gateway === null) {
    gateway = new Gateway();
  }
  return gateway;
}
