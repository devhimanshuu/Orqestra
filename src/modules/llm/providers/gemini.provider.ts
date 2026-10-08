import { z } from "zod";
import { getEnv } from "@/config/env";
import {
  LLMProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../llm.types";

/**
 * Google Gemini adapter.
 *
 * Talks to the public REST API directly (no SDK dependency): application
 * code never sees generativelanguage.googleapis.com — only LLMProvider.
 * `buildGeminiRequest` / `parseGeminiResponse` are pure functions so the
 * translation layer is unit-testable without network access.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 30_000;

export function buildGeminiRequest(request: LLMRequest): Record<string, unknown> {
  const systemParts = request.messages.filter((message) => message.role === "system");
  const conversation = request.messages.filter((message) => message.role !== "system");

  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) {
    generationConfig["temperature"] = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    generationConfig["maxOutputTokens"] = request.maxTokens;
  }
  if (request.stop !== undefined && request.stop.length > 0) {
    generationConfig["stopSequences"] = request.stop;
  }
  if (request.responseFormat === "json") {
    generationConfig["responseMimeType"] = "application/json";
  }

  const body: Record<string, unknown> = {
    contents: conversation.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
  };
  if (systemParts.length > 0) {
    body["systemInstruction"] = {
      parts: [{ text: systemParts.map((message) => message.content).join("\n") }],
    };
  }
  if (Object.keys(generationConfig).length > 0) {
    body["generationConfig"] = generationConfig;
  }
  return body;
}

const geminiResponseSchema = z.object({
  // A successful Gemini response always carries at least one candidate; anything
  // else (blocked prompts, error bodies) is treated as an invalid response.
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string() })) }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .min(1, "Gemini response contained no candidates"),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
});

export interface ParsedGeminiResponse {
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export function parseGeminiResponse(data: unknown): ParsedGeminiResponse {
  const parsed = geminiResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new LLMProviderError(
      "invalid_response",
      "gemini",
      "Gemini returned a response that does not match the expected schema",
    );
  }
  const candidate = parsed.data.candidates?.[0];
  const content = candidate?.content?.parts?.map((part) => part.text).join("") ?? "";
  const promptTokens = parsed.data.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = parsed.data.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    content,
    finishReason: candidate?.finishReason ?? null,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: parsed.data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
    },
  };
}

export const geminiProvider: LLMProvider = {
  id: "gemini",
  name: "Google Gemini",

  isConfigured(): boolean {
    return getEnv().GEMINI_API_KEY.trim() !== "";
  },

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = getEnv().GEMINI_API_KEY.trim();
    if (apiKey === "") {
      throw new LLMProviderError("provider_not_configured", "gemini", "GEMINI_API_KEY is not set");
    }

    const url = `${API_BASE}/${request.model}:generateContent`;
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Header (not query param) so the key never appears in URLs/logs.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(buildGeminiRequest(request)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new LLMProviderError(
        timedOut ? "timeout" : "provider_error",
        "gemini",
        timedOut ? "Gemini request timed out" : `Gemini request failed: ${String(error)}`,
        { retryable: true, cause: error },
      );
    }

    if (response.status === 429) {
      throw new LLMProviderError("rate_limited", "gemini", "Gemini rate limit exceeded", {
        retryable: true,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LLMProviderError(
        "provider_error",
        "gemini",
        `Gemini returned HTTP ${response.status}: ${detail.slice(0, 300)}`,
        { retryable: response.status >= 500 },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LLMProviderError("invalid_response", "gemini", "Gemini returned non-JSON body", {
        cause: error,
      });
    }

    const parsed = parseGeminiResponse(payload);
    return {
      provider: "gemini",
      model: request.model,
      content: parsed.content,
      finishReason: parsed.finishReason,
      usage: parsed.usage,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  },
};
