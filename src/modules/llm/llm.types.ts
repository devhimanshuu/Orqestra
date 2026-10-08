/**
 * LLM abstraction layer.
 *
 *   Orqestra runtime → LLM Gateway → LLMProvider → Gemini / Ollama / …
 *
 * Application code (runtime, harness nodes, services) only ever sees these
 * types. No provider SDK may be imported outside src/modules/llm/providers.
 * Model selection travels as data ("gemini:gemini-2.0-flash"), so harness
 * definitions stay portable across providers.
 */

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMRequest {
  /** Provider-specific model id, e.g. "gemini-2.0-flash" or "llama3.1". */
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: "text" | "json";
  /** Free-form bookkeeping (runId, nodeId…) — passed through untouched. */
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  provider: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage: LLMUsage;
  latencyMs: number;
}

export interface LLMChunk {
  provider: string;
  model: string;
  /** Incremental text delta. */
  delta: string;
  finishReason?: string | null;
  done: boolean;
}

export type LLMProviderErrorCode =
  "provider_not_configured" | "provider_error" | "rate_limited" | "invalid_response" | "timeout";

export class LLMProviderError extends Error {
  public readonly code: LLMProviderErrorCode;
  public readonly provider: string;
  public readonly retryable: boolean;

  constructor(
    code: LLMProviderErrorCode,
    provider: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LLMProviderError";
    this.code = code;
    this.provider = provider;
    this.retryable = options.retryable ?? false;
  }
}

export interface LLMProvider {
  /** Stable id used in model refs ("gemini:…", "ollama:…"). */
  readonly id: string;
  /** Human-readable name for UI listings. */
  readonly name: string;
  /** False when required credentials/config are absent — gateway reports this without throwing. */
  isConfigured(): boolean;
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Streaming is optional; Phase 2 wires it into the runtime. */
  stream?(request: LLMRequest): AsyncIterable<LLMChunk>;
}

/** "provider:model" reference resolved by the gateway. */
export interface ModelRef {
  provider: string;
  model: string;
}

/** Parses "gemini:gemini-2.0-flash" into { provider, model }. */
export function parseModelRef(ref: string): ModelRef | null {
  const separator = ref.indexOf(":");
  if (separator <= 0 || separator === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, separator).trim(),
    model: ref.slice(separator + 1).trim(),
  };
}
