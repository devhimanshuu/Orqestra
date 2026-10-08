import { describe, expect, it } from "vitest";
import { getLLMGateway } from "./llm.gateway";
import { LLMProviderError, parseModelRef } from "./llm.types";
import { buildGeminiRequest, parseGeminiResponse } from "./providers/gemini.provider";
import { buildOllamaRequest, parseOllamaResponse } from "./providers/ollama.provider";

describe("parseModelRef", () => {
  it("splits provider:model references", () => {
    expect(parseModelRef("gemini:gemini-2.0-flash")).toEqual({
      provider: "gemini",
      model: "gemini-2.0-flash",
    });
    expect(parseModelRef("ollama:llama3.1")).toEqual({ provider: "ollama", model: "llama3.1" });
  });

  it("rejects malformed references", () => {
    expect(parseModelRef("gemini")).toBeNull();
    expect(parseModelRef(":model")).toBeNull();
    expect(parseModelRef("provider:")).toBeNull();
  });
});

describe("llm gateway", () => {
  it("lists the built-in providers", () => {
    const providers = getLLMGateway().listProviders();
    const ids = providers.map((provider) => provider.id);
    expect(ids).toContain("gemini");
    expect(ids).toContain("ollama");
  });

  it("reports unconfigured providers instead of throwing at list time", () => {
    const gemini = getLLMGateway()
      .listProviders()
      .find((provider) => provider.id === "gemini");
    expect(gemini?.configured).toBe(false); // GEMINI_API_KEY is empty in tests
  });

  it("fails with provider_not_configured for unknown providers", async () => {
    await expect(
      getLLMGateway().generate("nope:model", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });

  it("fails with provider_not_configured when credentials are missing", async () => {
    await expect(
      getLLMGateway().generate("gemini:gemini-2.0-flash", {
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });

  it("rejects invalid model references", async () => {
    await expect(
      getLLMGateway().generate("gemini", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("gemini translation layer", () => {
  it("maps system messages to systemInstruction and configures generation", () => {
    const body = buildGeminiRequest({
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.3,
      maxTokens: 128,
      stop: ["###"],
      responseFormat: "json",
    });

    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "Be concise." }] });
    expect(body["contents"]).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
    expect(body["generationConfig"]).toEqual({
      temperature: 0.3,
      maxOutputTokens: 128,
      stopSequences: ["###"],
      responseMimeType: "application/json",
    });
  });

  it("maps assistant turns to the model role", () => {
    const body = buildGeminiRequest({
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });

  it("parses responses and normalizes usage", () => {
    const parsed = parseGeminiResponse({
      candidates: [
        { content: { parts: [{ text: "Hello " }, { text: "world" }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    });
    expect(parsed.content).toBe("Hello world");
    expect(parsed.finishReason).toBe("STOP");
    expect(parsed.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("rejects malformed provider payloads", () => {
    expect(() => parseGeminiResponse({ nope: true })).toThrow(LLMProviderError);
  });
});

describe("ollama translation layer", () => {
  it("builds chat requests with options", () => {
    const body = buildOllamaRequest({
      model: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.1,
      maxTokens: 64,
      responseFormat: "json",
    });
    expect(body).toMatchObject({
      model: "llama3.1",
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 64 },
    });
  });

  it("parses responses and normalizes usage", () => {
    const parsed = parseOllamaResponse({
      message: { role: "assistant", content: "hi there" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 11,
      eval_count: 4,
    });
    expect(parsed.content).toBe("hi there");
    expect(parsed.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
  });

  it("rejects malformed payloads", () => {
    expect(() => parseOllamaResponse({ message: "nope" })).toThrow(LLMProviderError);
  });
});
