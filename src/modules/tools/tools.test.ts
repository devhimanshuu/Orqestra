import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { getToolRegistry } from "./index";
import { ToolError } from "./tool.types";
import { calculatorTool } from "./tools/calculator";
import { currentTimeTool } from "./tools/current-time";
import { httpFetchTool } from "./tools/http-fetch";
import { jsonTransformTool } from "./tools/json-transform";
import { logger } from "@/lib/logging/logger";

const context = { logger, metadata: {} };

describe("calculator", () => {
  it("evaluates arithmetic with precedence and parentheses", async () => {
    const result = await calculatorTool.execute({ expression: "2 + 5 * 10" }, context);
    expect(result.output.result).toBe(52);

    const grouped = await calculatorTool.execute({ expression: "(2 + 5) * 10" }, context);
    expect(grouped.output.result).toBe(70);

    const negative = await calculatorTool.execute({ expression: "-4 + 1 / 2" }, context);
    expect(negative.output.result).toBe(-3.5);
  });

  it("rejects malformed input and division by zero", async () => {
    expect(() => calculatorTool.inputSchema.parse({ expression: "" })).toThrow();
    await expect(calculatorTool.execute({ expression: "2 + " }, context)).rejects.toThrow();
    await expect(calculatorTool.execute({ expression: "1 / 0" }, context)).rejects.toThrow(
      "Division by zero",
    );
  });
});

describe("json_transform", () => {
  it("applies operations in order", async () => {
    const result = await jsonTransformTool.execute(
      {
        source: { plan: ["a", "b", "c"], meta: { owner: "team" } },
        operations: [{ op: "path", key: "plan" }, { op: "limit", limit: 2 }],
      },
      context,
    );
    expect(result.output.value).toEqual(["a", "b"]);
    expect(result.output.operations).toEqual(["path", "limit"]);
  });

  it("supports pick, omit, sortBy, count and join", async () => {
    const picked = await jsonTransformTool.execute(
      { source: { a: 1, b: 2, c: 3 }, operations: [{ op: "pick", keys: ["a", "c"] }] },
      context,
    );
    expect(picked.output.value).toEqual({ a: 1, c: 3 });

    const omitted = await jsonTransformTool.execute(
      { source: { a: 1, b: 2 }, operations: [{ op: "omit", keys: ["b"] }] },
      context,
    );
    expect(omitted.output.value).toEqual({ a: 1 });

    const sorted = await jsonTransformTool.execute(
      {
        source: [{ n: 3 }, { n: 1 }, { n: 2 }],
        operations: [{ op: "sortBy", key: "n", direction: "desc" }],
      },
      context,
    );
    expect(sorted.output.value).toEqual([{ n: 3 }, { n: 2 }, { n: 1 }]);

    const counted = await jsonTransformTool.execute(
      { source: [1, 2, 3], operations: [{ op: "count" }] },
      context,
    );
    expect(counted.output.value).toBe(3);

    const joined = await jsonTransformTool.execute(
      { source: ["a", "b"], operations: [{ op: "join", separator: ", " }] },
      context,
    );
    expect(joined.output.value).toBe("a, b");
  });

  it("fails with a structured error when a path is missing", async () => {
    await expect(
      jsonTransformTool.execute(
        { source: { a: 1 }, operations: [{ op: "path", key: "nope" }] },
        context,
      ),
    ).rejects.toThrow(ToolError);
  });
});

describe("current_time", () => {
  it("returns a coherent time record and accepts unrelated input", async () => {
    const result = await currentTimeTool.execute({ plan: ["step 1"] }, context);
    expect(new Date(result.output.iso).getTime()).toBe(result.output.epochMs);
    expect(result.output.timeZone).toBeTruthy();
    expect(typeof result.output.formatted).toBe("string");
  });

  it("honours an explicit timezone and falls back on an unknown one", async () => {
    const result = await currentTimeTool.execute({ timeZone: "UTC" }, context);
    expect(result.output.timeZone).toBe("UTC");
    const bogus = await currentTimeTool.execute({ timeZone: "Mars/Olympus" }, context);
    expect(bogus.output.formatted).toBe(bogus.output.iso);
  });
});

describe("http_fetch", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, hits: 2 }));
        return;
      }
      if (request.url === "/binary") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      if (request.url === "/slow") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("too late");
        }, 200);
        return;
      }
      if (request.url === "/large") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(5_000));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches text and JSON bodies", async () => {
    const result = await httpFetchTool.execute({ url: `${baseUrl}/json` }, context);
    expect(result.output.status).toBe(200);
    expect(result.output.ok).toBe(true);
    expect(result.output.contentType).toBe("application/json");
    expect(JSON.parse(result.output.text)).toEqual({ ok: true, hits: 2 });
  });

  it("refuses non-text content types", async () => {
    await expect(httpFetchTool.execute({ url: `${baseUrl}/binary` }, context)).rejects.toThrow(
      /not text/,
    );
  });

  it("times out", async () => {
    await expect(
      httpFetchTool.execute({ url: `${baseUrl}/slow`, timeoutMs: 100 }, context),
    ).rejects.toThrow(/timed out/);
  });

  it("truncates oversized bodies", async () => {
    const result = await httpFetchTool.execute(
      { url: `${baseUrl}/large`, maxBytes: 1_000 },
      context,
    );
    expect(result.output.truncated).toBe(true);
    expect(result.output.text).toHaveLength(1_000);
  });

  it("refuses non-http protocols", async () => {
    await expect(httpFetchTool.execute({ url: "file:///etc/passwd" }, context)).rejects.toThrow(
      ToolError,
    );
  });

  it("blocks private and metadata hosts outside the test environment", async () => {
    // Vitest sets NODE_ENV=test to allow the local fixture server; simulate the
    // production rule here (the guard is the security property under test).
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(httpFetchTool.execute({ url: "http://localhost:3000/" }, context)).rejects.toThrow(
        /private or metadata/,
      );
      await expect(
        httpFetchTool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, context),
      ).rejects.toThrow(/private or metadata/);
      await expect(
        httpFetchTool.execute({ url: "http://10.0.0.5/internal" }, context),
      ).rejects.toThrow(/private or metadata/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("tool registry", () => {
  it("registers the built-in tools exactly once and validates input", async () => {
    const registry = getToolRegistry();
    expect(registry.list().map((tool) => tool.id)).toEqual([
      "calculator",
      "json_transform",
      "current_time",
      "http_fetch",
    ]);
    expect(registry.has("calculator")).toBe(true);

    await expect(registry.execute("calculator", { expression: "" }, context)).rejects.toThrow(
      ToolError,
    );
    await expect(registry.execute("nope", {}, context)).rejects.toThrow(/not registered/);
  });
});
