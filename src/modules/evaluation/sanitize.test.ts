import { describe, expect, it } from "vitest";
import {
  REDACTED,
  buildRunTraceExport,
  isSensitiveKey,
  redactSecretsInText,
  safeErrorMessage,
  sanitizeValue,
} from "./sanitize";
import type { RunDetail } from "@/modules/runtime/run.types";

describe("sanitizeValue", () => {
  it("redacts values whose key names a secret", () => {
    const result = sanitizeValue({
      url: "https://example.com",
      apiKey: "abc",
      authorization: "Bearer xyz",
      nested: { password: "hunter2", clientSecret: "s" },
    }) as Record<string, unknown>;
    expect(result["url"]).toBe("https://example.com");
    expect(result["apiKey"]).toBe(REDACTED);
    expect(result["authorization"]).toBe(REDACTED);
    expect((result["nested"] as Record<string, unknown>)["password"]).toBe(REDACTED);
    expect((result["nested"] as Record<string, unknown>)["clientSecret"]).toBe(REDACTED);
  });

  it("redacts secret-looking values inside otherwise harmless strings", () => {
    const result = sanitizeValue(
      "fetching https://api.example.com?api_key=supersecret&x=1 with Authorization: Bearer abcdefghijklmno",
    ) as string;
    expect(result).toContain("api_key=[redacted]");
    expect(result).toContain("Bearer [redacted]");
    expect(result).not.toContain("supersecret");
    expect(result).not.toContain("abcdefghijklmno");
    expect(result).toContain("x=1");
  });

  it("redacts JWTs and provider key shapes", () => {
    const mockSkKey = "sk-" + "dummySecretPlaceholder123";
    const mockGoogleKey = "AIza" + "dummyKey1234567890abcdefghijklmnopqrst";
    const mockJwt = ["eyJ" + "dummyHeader12345", "dummyPayload12345", "dummySignature12345"].join(".");

    expect(redactSecretsInText(`token ${mockSkKey}`)).toContain("[redacted-secret]");
    expect(redactSecretsInText(`key ${mockGoogleKey}`)).toContain("[redacted-secret]");
    expect(redactSecretsInText(`jwt ${mockJwt}`)).toContain("[redacted-jwt]");
  });

  it("caps depth, array length and string length", () => {
    const deep = { a: { b: { c: { d: "value" } } } };
    const result = sanitizeValue(deep, { maxDepth: 2 }) as Record<string, unknown>;
    expect(JSON.stringify(result)).toContain("[truncated: depth]");

    const array = sanitizeValue([1, 2, 3, 4, 5], { maxArrayItems: 2 }) as unknown[];
    expect(array).toHaveLength(3);
    expect(array[2]).toMatch(/more items/);

    const long = sanitizeValue("x".repeat(50), { maxStringLength: 10 });
    expect(String(long).length).toBeLessThan(30);
  });

  it("handles cycles, dates and errors without throwing", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular["self"] = circular;
    const result = sanitizeValue(circular) as Record<string, unknown>;
    expect(result["self"]).toBe("[circular]");

    expect(sanitizeValue(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    const error = sanitizeValue(new Error("failed with token=abcdef")) as Record<string, unknown>;
    expect(error["name"]).toBe("Error");
    expect(error["message"]).toContain("token=[redacted]");

    // Functions and symbols are not JSON-representable, so they vanish rather
    // than turning into a misleading value.
    expect(sanitizeValue({ keep: 1, fn: () => undefined, sym: Symbol("s") })).toEqual({
      keep: 1,
      fn: undefined,
      sym: undefined,
    });
    expect(JSON.stringify(sanitizeValue({ fn: () => undefined }))).toBe("{}");
  });
});

describe("safeErrorMessage", () => {
  it("keeps a helpful message but strips secrets and caps length", () => {
    expect(safeErrorMessage(new Error("request failed: key sk-abcdefghijklmnopqrstuvwxyz rejected"))).toContain(
      "[redacted-secret]",
    );
    expect(safeErrorMessage(new Error("x".repeat(2_000))).length).toBeLessThanOrEqual(501);
    expect(safeErrorMessage("plain string")).toBe("plain string");
    expect(safeErrorMessage(null)).toBe("Unexpected error");
  });
});

describe("isSensitiveKey", () => {
  it("matches credential-shaped keys", () => {
    for (const key of ["apiKey", "api_key", "AUTHORIZATION", "sessionId", "privateKey", "cookie"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey("input")).toBe(false);
    expect(isSensitiveKey("tokenCount")).toBe(true); // conservative: 'token' anywhere
  });
});

describe("buildRunTraceExport", () => {
  const detail: RunDetail = {
    run: {
      id: "run-1",
      harnessId: "harness-1",
      harnessVersionId: "hv-1",
      agentId: "agent-1",
      agentVersion: 1,
      status: "SUCCEEDED",
      input: "task",
      output: "answer",
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: 0.0001,
      latencyMs: 900,
      error: null,
      metadata: {
        engineVersion: "0.2.0",
        harnessContentHash: "hash",
        harnessVersion: 1,
        nodeCount: 2,
        edgeCount: 1,
        nodeTypes: ["start", "end"],
        model: "gemini-2.0-flash",
        provider: "gemini",
        limits: {
          maxDurationMs: 1,
          maxNodes: 1,
          maxIterations: 1,
          maxToolCalls: 1,
          maxLlmCalls: 1,
          maxCostUsd: null,
        },
        allowedTools: [],
        executionMode: "inline",
        apiKey: "leaked",
      },
      attempt: 1,
      retryOfRunId: null,
      cancelRequestedAt: null,
      startedAt: new Date("2026-01-01T10:00:00Z"),
      completedAt: new Date("2026-01-01T10:00:01Z"),
      createdAt: new Date("2026-01-01T09:59:59Z"),
    },
    steps: [
      {
        id: "step-1",
        runId: "run-1",
        index: 0,
        nodeId: "start",
        nodeType: "start",
        nodeLabel: "Start",
        status: "SUCCEEDED",
        input: "task",
        output: { toolResult: "called https://api.example.com?key=hidden" },
        error: null,
        metadata: { authorization: "Bearer leaked" },
        iteration: null,
        startedAt: new Date("2026-01-01T10:00:00Z"),
        completedAt: new Date("2026-01-01T10:00:00Z"),
        durationMs: 1,
        createdAt: new Date("2026-01-01T10:00:00Z"),
      },
    ],
    events: [
      {
        seq: 1,
        type: "RUN_STARTED",
        payload: {
          type: "RUN_STARTED",
          runId: "run-1",
          seq: 1,
          at: "2026-01-01T10:00:00.000Z",
          entryNode: "start",
        },
        at: new Date("2026-01-01T10:00:00Z"),
      },
    ],
    usage: [
      {
        provider: "gemini",
        model: "gemini-2.0-flash",
        calls: 1,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0.0001,
      },
    ],
    usageTotal: { calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.0001, unknownCost: false },
    harness: { id: "harness-1", name: "Harness", slug: "harness" },
    harnessVersionLabel: 1,
    agent: { id: "agent-1", name: "Agent" },
    live: false,
  };

  it("produces a sanitized, self-describing trace", () => {
    const exported = buildRunTraceExport(detail, new Date("2026-01-02T00:00:00Z"));
    expect(exported.kind).toBe("orqestra.run-trace");
    expect(exported.sanitized).toBe(true);
    expect(exported.run.costKind).toBe("estimated");
    expect(exported.steps).toHaveLength(1);
    expect(exported.events[0]?.type).toBe("RUN_STARTED");
    expect(exported.usage[0]?.totalTokens).toBe(15);
  });

  it("redacts secrets from every section", () => {
    const serialized = JSON.stringify(buildRunTraceExport(detail, new Date("2026-01-02T00:00:00Z")));
    expect(serialized).not.toContain("leaked");
    expect(serialized).not.toContain("hidden");
    expect(serialized).toContain(REDACTED);
    // A URL query string inside a tool result is scrubbed by value…
    expect(serialized).toContain("key=[redacted]");
    // …and a sensitive key is replaced wholesale, name and value both gone.
    expect(serialized).toContain('"authorization":"[redacted]"');
  });

  it("is valid JSON with no undefined values", () => {
    const exported = buildRunTraceExport(detail, new Date("2026-01-02T00:00:00Z"));
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("undefined");
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
