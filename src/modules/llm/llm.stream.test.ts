import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLLMGateway } from "./llm.gateway";
import { LLMProviderError, type LLMChunk, type LLMRequest } from "./llm.types";
import { parseGeminiSseLine } from "./providers/gemini.provider";
import {
  checkOllamaHealth,
  resetOllamaHealthCache,
} from "./providers/ollama.provider";
import { consumeTextStream } from "./providers/stream.utils";
import { resetEnvCache } from "@/config/env";

function sseBody(...events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

const request: LLMRequest = {
  model: "gemini-2.0-flash",
  messages: [{ role: "user", content: "hi" }],
};

describe("consumeTextStream", () => {
  it("yields one chunk per non-empty line and always ends with done", async () => {
    const chunks = await collect(
      consumeTextStream(
        sseBody('data: {"a":1}\n\ndata: {"a":2}\n'),
        (line) => ({ provider: "test", model: "m", delta: line, done: false }),
        "test",
        "m",
      ),
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.delta).toBe('data: {"a":1}');
    expect(chunks[1]?.delta).toBe('data: {"a":2}');
    expect(chunks[2]?.done).toBe(true);
    expect(chunks[2]?.delta).toBe("");
  });

  it("does not append a terminal chunk when the stream already reported done", async () => {
    const chunks = await collect(
      consumeTextStream(
        sseBody("line1\nline2\n"),
        (line) => ({
          provider: "test",
          model: "m",
          delta: line,
          done: line === "line2",
        }),
        "test",
        "m",
      ),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.done).toBe(true);
  });

  it("reassembles lines split across network chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("da"));
        controller.enqueue(encoder.encode("ta: {\"x\":1}\nda"));
        controller.enqueue(encoder.encode('ta: {"x":2}\n'));
        controller.close();
      },
    });
    const chunks = await collect(
      consumeTextStream(
        stream,
        (line) => ({ provider: "test", model: "m", delta: line, done: false }),
        "test",
        "m",
      ),
    );
    expect(chunks.map((chunk) => chunk.delta)).toEqual([
      'data: {"x":1}',
      'data: {"x":2}',
      "",
    ]);
  });

  it("lets toChunk skip malformed lines without aborting the stream", async () => {
    const chunks = await collect(
      consumeTextStream(
        sseBody("good\nbroken\ngood2\n"),
        (line) =>
          line === "broken"
            ? null
            : { provider: "test", model: "m", delta: line, done: false },
        "test",
        "m",
      ),
    );
    expect(chunks.map((chunk) => chunk.delta)).toEqual(["good", "good2", ""]);
  });
});

describe("parseGeminiSseLine", () => {
  it("extracts JSON payloads from data lines", () => {
    expect(parseGeminiSseLine('data: {"candidates":[]}')).toEqual({
      candidates: [],
    });
  });

  it("ignores keep-alives, [DONE] and non-data lines", () => {
    expect(parseGeminiSseLine("")).toBeNull();
    expect(parseGeminiSseLine(": keep-alive")).toBeNull();
    expect(parseGeminiSseLine("data: [DONE]")).toBeNull();
    expect(parseGeminiSseLine("event: message")).toBeNull();
  });

  it("returns null for undecodable payloads", () => {
    expect(parseGeminiSseLine("data: {not json")).toBeNull();
  });
});

describe("gateway stream", () => {
  it("streams from the mock provider through the gateway", async () => {
    const chunks = await collect(
      getLLMGateway().stream!("mock:deterministic", {
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.done).toBe(true);
    const text = chunks.map((chunk) => chunk.delta).join("");
    expect(text.length).toBeGreaterThan(0);
  });

  it("fails with provider_not_configured for unconfigured providers", async () => {
    await expect(async () => {
      await collect(
        getLLMGateway().stream!("gemini:gemini-2.0-flash", {
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    }).rejects.toMatchObject({ code: "provider_not_configured" });
  });

  it("rejects invalid model references", async () => {
    await expect(async () => {
      await collect(getLLMGateway().stream!("nope", { messages: [] }));
    }).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("ollama health probe", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOllamaHealthCache();
    resetEnvCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOllamaHealthCache();
    resetEnvCache();
  });

  it("reports reachable when the server answers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(checkOllamaHealth()).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/version",
      expect.anything(),
    );
  });

  it("reports unreachable instead of throwing when the server is down", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(checkOllamaHealth()).resolves.toBe(false);
  });

  it("caches the result so repeated probes do not refetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) as unknown as typeof fetch;

    await checkOllamaHealth();
    await checkOllamaHealth();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("marks the provider unconfigured while the server is known down", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const gateway = getLLMGateway();
    await checkOllamaHealth();
    const ollama = gateway.listProviders().find((entry) => entry.id === "ollama");
    expect(ollama?.configured).toBe(false);
  });

  it("fails generate fast with a clear message when Ollama is down", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(
      getLLMGateway().generate("ollama:llama3.1", {
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/not reachable/);
  });
});

describe("ollama streaming", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOllamaHealthCache();
    resetEnvCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOllamaHealthCache();
    resetEnvCache();
  });

  it("emits one chunk per NDJSON line and terminates on done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 })) // health probe
      .mockResolvedValueOnce(
        new Response(
          [
            JSON.stringify({ message: { role: "assistant", content: "Hel" }, done: false }),
            JSON.stringify({ message: { role: "assistant", content: "lo" }, done: false }),
            JSON.stringify({
              message: { role: "assistant", content: "" },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 3,
              eval_count: 2,
            }),
          ].join("\n") + "\n",
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const chunks = await collect(
      getLLMGateway().stream!("ollama:llama3.1", {
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.map((chunk) => chunk.delta)).toEqual(["Hel", "lo", ""]);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.at(-1)?.finishReason).toBe("stop");

    // The chat request must opt into streaming.
    const chatCall = fetchMock.mock.calls[1];
    const body = JSON.parse(chatCall?.[1]?.body as string) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it("skips malformed NDJSON lines without aborting", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          [
            "{not json",
            JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" }),
          ].join("\n") + "\n",
          { status: 200 },
        ),
      ) as unknown as typeof fetch;

    const chunks = await collect(
      getLLMGateway().stream!("ollama:llama3.1", {
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(chunks.map((chunk) => chunk.delta)).toEqual(["ok"]);
    expect(chunks.at(-1)?.done).toBe(true);
  });
});

describe("gemini streaming", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetEnvCache();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetEnvCache();
    vi.unstubAllEnvs();
  });

  it("emits deltas from SSE events and terminates on finishReason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}',
          "",
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const chunks = await collect(
      getLLMGateway().stream!("gemini:gemini-2.0-flash", {
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.map((chunk) => chunk.delta)).toEqual(["Hel", "lo"]);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.at(-1)?.finishReason).toBe("STOP");

    // Endpoint must be the streaming variant with SSE asked for.
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain(":streamGenerateContent?alt=sse");
  });

  it("fails with provider_not_configured when the key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    resetEnvCache();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(async () => {
      await collect(
        getLLMGateway().stream!("gemini:gemini-2.0-flash", {
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    }).rejects.toBeInstanceOf(LLMProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
