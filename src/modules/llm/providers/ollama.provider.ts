import { z } from "zod";
import { getEnv } from "@/config/env";
import {
  LLMProviderError,
  type LLMChunk,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../llm.types";
import { consumeTextStream } from "./stream.utils";

/**
 * Ollama adapter — talks to a local Ollama server via its REST API.
 * No API key required; availability is detected at call time so the app
 * runs fine when Ollama isn't installed.
 */

const REQUEST_TIMEOUT_MS = 120_000; // local models can be slow
const HEALTH_TIMEOUT_MS = 2_000;
/** Reachability results are cached so repeated checks don't hammer a dead server. */
const HEALTH_TTL_MS = 30_000;

let cachedHealth: { reachable: boolean; at: number } | null = null;

/**
 * Probe the local Ollama server (`GET /api/version`). Results are cached for
 * 30 s; a failure marks the provider unreachable instead of throwing.
 */
export async function checkOllamaHealth(): Promise<boolean> {
  const now = Date.now();
  if (cachedHealth !== null && now - cachedHealth.at < HEALTH_TTL_MS) {
    return cachedHealth.reachable;
  }
  const baseUrl = getEnv().OLLAMA_BASE_URL.replace(/\/+$/, "");
  let reachable = false;
  try {
    const response = await fetch(`${baseUrl}/api/version`, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  cachedHealth = { reachable, at: now };
  return reachable;
}

/** Test hook: drop the cached reachability result. */
export function resetOllamaHealthCache(): void {
  cachedHealth = null;
}

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
    // No credentials needed; a known-unreachable server (cached health check)
    // counts as unconfigured so listings don't advertise it.
    if (getEnv().OLLAMA_BASE_URL.trim() === "") {
      return false;
    }
    return cachedHealth === null || cachedHealth.reachable;
  },

  checkHealth(): Promise<boolean> {
    return checkOllamaHealth();
  },

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const baseUrl = getEnv().OLLAMA_BASE_URL.replace(/\/+$/, "");

    if (!(await checkOllamaHealth())) {
      throw new LLMProviderError(
        "provider_not_configured",
        "ollama",
        `Ollama is not reachable at ${baseUrl} — start it with "ollama serve"`,
      );
    }

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

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const baseUrl = getEnv().OLLAMA_BASE_URL.replace(/\/+$/, "");

    if (!(await checkOllamaHealth())) {
      throw new LLMProviderError(
        "provider_not_configured",
        "ollama",
        `Ollama is not reachable at ${baseUrl} — start it with "ollama serve"`,
      );
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildOllamaRequest(request),
          stream: true,
        }),
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
    if (response.body === null) {
      throw new LLMProviderError("invalid_response", "ollama", "Ollama stream had no body");
    }

    // Ollama streams newline-delimited JSON; each line reuses the non-stream
    // schema (message.content carries the delta for that step).
    yield* consumeTextStream(
      response.body,
      (line) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          return null;
        }
        const parsed = ollamaResponseSchema.safeParse(payload);
        if (!parsed.success) {
          return null;
        }
        return {
          provider: "ollama",
          model: request.model,
          delta: parsed.data.message.content,
          finishReason: parsed.data.done ? (parsed.data.done_reason ?? "stop") : null,
          done: parsed.data.done,
        };
      },
      "ollama",
      request.model,
    );
  },
};
