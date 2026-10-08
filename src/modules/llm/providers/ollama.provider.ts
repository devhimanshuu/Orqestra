import { z } from "zod";
import { getEnv } from "@/config/env";
import {
  LLMProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../llm.types";

/**
 * Ollama adapter — talks to a local Ollama server via its REST API.
 * No API key required; availability is detected at call time so the app
 * runs fine when Ollama isn't installed.
 */

const REQUEST_TIMEOUT_MS = 120_000; // local models can be slow

export function buildOllamaRequest(request: LLMRequest): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (request.temperature !== undefined) {
    options["temperature"] = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    options["num_predict"] = request.maxTokens;
  }
  if (request.stop !== undefined && request.stop.length > 0) {
    options["stop"] = request.stop;
  }

  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: false,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(request.responseFormat === "json" ? { format: "json" } : {}),
  };
}

const ollamaResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({ role: z.string(), content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export function parseOllamaResponse(data: unknown): {
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
} {
  const parsed = ollamaResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new LLMProviderError(
      "invalid_response",
      "ollama",
      "Ollama returned a response that does not match the expected schema",
    );
  }
  const promptTokens = parsed.data.prompt_eval_count ?? 0;
  const completionTokens = parsed.data.eval_count ?? 0;
  return {
    content: parsed.data.message.content,
    finishReason: parsed.data.done_reason ?? (parsed.data.done ? "stop" : null),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

export const ollamaProvider: LLMProvider = {
  id: "ollama",
  name: "Ollama (local)",

  isConfigured(): boolean {
    // Ollama needs no credentials; the base URL always has a default.
    return getEnv().OLLAMA_BASE_URL.trim() !== "";
  },

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const baseUrl = getEnv().OLLAMA_BASE_URL.replace(/\/+$/, "");
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildOllamaRequest(request)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new LLMProviderError(
        timedOut ? "timeout" : "provider_error",
        "ollama",
        timedOut
          ? "Ollama request timed out"
          : `Could not reach Ollama at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const missingModel = detail.toLowerCase().includes("not found");
      throw new LLMProviderError(
        "provider_error",
        "ollama",
        missingModel
          ? `Ollama model "${request.model}" is not pulled — run: ollama pull ${request.model}`
          : `Ollama returned HTTP ${response.status}: ${detail.slice(0, 300)}`,
        { retryable: response.status >= 500 },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LLMProviderError("invalid_response", "ollama", "Ollama returned non-JSON body", {
        cause: error,
      });
    }

    const parsed = parseOllamaResponse(payload);
    return {
      provider: "ollama",
      model: request.model,
      content: parsed.content,
      finishReason: parsed.finishReason,
      usage: parsed.usage,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  },
};
