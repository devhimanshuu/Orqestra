/**
 * Mock LLM provider — deterministic, offline, free.
 *
 * Two jobs:
 *  1. make the runtime testable without Gemini/Ollama and without spending
 *     credits — the same harness + input + mock script always produces the same
 *     trace;
 *  2. let a user dry-run a harness end to end in the builder ("mock:deterministic")
 *     before wiring a real provider.
 *
 * Determinism: token counts are derived from character length, latency is
 * reported as 0, and default responses are computed from the prompt by a fixed
 * rule set (no randomness, no clock, no network). Tests can script exact
 * responses — including failures — through `queueMockResponses()`.
 */

import { createHash } from "node:crypto";
import type { LLMChunk, LLMProvider, LLMRequest, LLMResponse } from "../llm.types";
import { LLMProviderError } from "../llm.types";

export type MockScript =
  | {
      kind: "success";
      /** Exact content to return. */
      content: string;
      /** Optional artificial usage; derived from the prompt when omitted. */
      usage?: { promptTokens: number; completionTokens: number };
      /** Optional artificial latency (ms) reported in the response. */
      latencyMs?: number;
      /** Throw instead of returning when set. */
      failWith?: { code: "provider_error" | "rate_limited" | "timeout"; retryable: boolean };
    }
  | {
      kind: "failure";
      code: "provider_error" | "rate_limited" | "timeout";
      message?: string;
      retryable?: boolean;
    };

const FAILURE_MESSAGES: Record<"provider_error" | "rate_limited" | "timeout", string> = {
  provider_error: "mock provider error",
  rate_limited: "mock rate limit (429)",
  timeout: "mock timeout",
};

const queue: MockScript[] = [];
const calls: LLMRequest[] = [];

/** Enqueues scripts consumed in order; once empty, deterministic defaults apply. */
export function queueMockResponses(...scripts: MockScript[]): void {
  queue.push(...scripts);
}

/** Requests served since the last reset (assert what the runtime actually sent). */
export function recordedMockRequests(): LLMRequest[] {
  return [...calls];
}

export function resetMockProvider(): void {
  queue.length = 0;
  calls.length = 0;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableSeed(request: LLMRequest): number {
  const hash = createHash("sha256")
    .update(JSON.stringify({ messages: request.messages, model: request.model }))
    .digest();
  return hash[0] ?? 0;
}

function lastUserContent(request: LLMRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function roleOf(request: LLMRequest): string {
  const role = request.metadata?.["role"];
  return typeof role === "string" ? role : "model";
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !entry.startsWith("{") && !entry.startsWith("["));
  return line ?? text.trim().slice(0, 120);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Default deterministic content per node role. */
function defaultContent(request: LLMRequest): string {
  const role = roleOf(request);
  const user = lastUserContent(request);
  const subject = firstMeaningfulLine(user);
  const seed = stableSeed(request);

  switch (role) {
    case "planner": {
      const steps = sentences(user).slice(0, 3);
      const plan =
        steps.length > 0
          ? steps.map((step, index) => `${index + 1}. ${step}`)
          : ["1. Inspect the task", "2. Gather evidence", "3. Summarise the answer"];
      return JSON.stringify(
        {
          plan,
          summary: `Plan with ${plan.length} steps for: ${subject.slice(0, 80)}`,
        },
        null,
        2,
      );
    }
    case "critic":
      return JSON.stringify(
        {
          // Deterministic score in [0.72, 0.98]: above the default 0.7 threshold
          // so a default harness converges, and stable for a given prompt.
          score: Number((0.72 + (seed % 27) / 100).toFixed(2)),
          issues: seed % 3 === 0 ? ["Evidence for the final claim is thin"] : [],
          summary: `Reviewed "${subject.slice(0, 60)}" — the draft is broadly supported`,
        },
        null,
        2,
      );
    case "evaluator":
      return JSON.stringify(
        {
          score: Number((0.7 + (seed % 25) / 100).toFixed(2)),
          rationale: `Deterministic evaluation of "${subject.slice(0, 60)}"`,
        },
        null,
        2,
      );
    default:
      return `Mock model response for: ${subject.slice(0, 200)}`;
  }
}

/** Deterministic "streaming": the content chunked into fixed-size pieces. */
async function* streamContent(content: string, model: string): AsyncIterable<LLMChunk> {
  const size = 24;
  for (let index = 0; index < content.length; index += size) {
    yield {
      provider: "mock",
      model,
      delta: content.slice(index, index + size),
      done: false,
    };
    await Promise.resolve();
  }
  yield { provider: "mock", model, delta: "", finishReason: "stop", done: true };
}

export const mockProvider: LLMProvider = {
  id: "mock",
  name: "Mock (deterministic simulator)",

  isConfigured(): boolean {
    return true;
  },

  async generate(request: LLMRequest): Promise<LLMResponse> {
    calls.push(request);
    const script = queue.shift();

    if (script !== undefined) {
      if (script.kind === "failure") {
        throw new LLMProviderError(
          script.code,
          "mock",
          script.message ?? FAILURE_MESSAGES[script.code],
          { retryable: script.retryable ?? script.code !== "provider_error" },
        );
      }
      if (script.failWith !== undefined) {
        throw new LLMProviderError(script.failWith.code, "mock", "Scripted mock failure", {
          retryable: script.failWith.retryable,
        });
      }
      const promptTokens = script.usage?.promptTokens ?? estimateTokens(
        request.messages.map((message) => message.content).join("\n"),
      );
      const completionTokens = script.usage?.completionTokens ?? estimateTokens(script.content);
      return {
        provider: "mock",
        model: request.model,
        content: script.content,
        finishReason: "stop",
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        latencyMs: script.latencyMs ?? 0,
      };
    }

    const content = defaultContent(request);
    const promptTokens = estimateTokens(
      request.messages.map((message) => message.content).join("\n"),
    );
    const completionTokens = estimateTokens(content);
    return {
      provider: "mock",
      model: request.model,
      content,
      finishReason: "stop",
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      latencyMs: 0,
    };
  },

  stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const content = defaultContent(request);
    return streamContent(content, request.model);
  },
};
