import { z } from "zod";
import { ToolError, type AgentTool, type ToolResult } from "../tool.types";

/**
 * HTTP fetch — the runtime's only outbound network capability.
 *
 * Safety rules (all enforced here, not by callers):
 *  - http/https only — no `file:`, `data:`, or anything else;
 *  - private, loopback, link-local and cloud-metadata hosts are refused, and the
 *    check is repeated on the *final* URL after redirects (SSRF guard);
 *  - a request timeout and a response size cap keep one tool call bounded;
 *  - only text-ish content types are returned; bodies are truncated, never
 *    streamed further.
 *
 * `NODE_ENV=test` relaxes the private-host rule so tests can run a local server —
 * it never relaxes in development or production.
 */

const inputSchema = z.object({
  url: z.string().url().max(2_000),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string().max(64), z.string().max(2_000)).optional(),
  body: z.string().max(100_000).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  maxBytes: z.number().int().min(256).max(1_000_000).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = {
  status: number;
  ok: boolean;
  contentType: string | null;
  finalUrl: string;
  truncated: boolean;
  text: string;
};

const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1$|.*\.internal$|.*\.local$)/i;

const METADATA_HOSTS = new Set(["metadata.google.internal", "169.254.169.254"]);

function assertHostAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolError("INVALID_INPUT", "http_fetch", `"${rawUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError(
      "EXECUTION_FAILED",
      "http_fetch",
      `Protocol "${parsed.protocol}" is not allowed — use http or https`,
    );
  }
  const allowPrivate = process.env["NODE_ENV"] === "test";
  if (!allowPrivate) {
    const host = parsed.hostname.toLowerCase();
    if (METADATA_HOSTS.has(host) || PRIVATE_HOST_PATTERN.test(host)) {
      throw new ToolError(
        "EXECUTION_FAILED",
        "http_fetch",
        `Host "${host}" is not reachable from the runtime (private or metadata address)`,
      );
    }
  }
  return parsed;
}

const TEXT_CONTENT_TYPES = ["application/json", "text/", "application/xml", "application/xhtml"];

export const httpFetchTool: AgentTool<Input, Output> = {
  id: "http_fetch",
  name: "HTTP fetch",
  description:
    "Fetches an http(s) URL and returns the response text. Refuses private hosts, non-text content, oversized bodies.",
  version: 1,
  inputSchema,
  async execute(input: Input, context): Promise<ToolResult<Output>> {
    const startedAt = performance.now();
    const url = assertHostAllowed(input.url);
    const timeoutMs = input.timeoutMs ?? 10_000;
    const maxBytes = input.maxBytes ?? 200_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: input.method ?? "GET",
        headers: {
          "user-agent": "Orqestra-Runtime/0.2 (+https://orqestra.dev)",
          accept: "application/json, text/*;q=0.9, */*;q=0.5",
          ...(input.headers ?? {}),
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
        signal: controller.signal,
        redirect: "follow",
      });

      // Re-check the redirect target: a public host may redirect to a private one.
      assertHostAllowed(response.url);

      const contentTypeHeader = response.headers.get("content-type");
      const contentType = contentTypeHeader?.split(";")[0]?.trim() ?? null;
      const isText =
        contentType === null ||
        TEXT_CONTENT_TYPES.some((allowed) => contentType.toLowerCase().startsWith(allowed));
      if (!isText) {
        throw new ToolError(
          "EXECUTION_FAILED",
          "http_fetch",
          `Content type "${contentType}" is not text — the runtime does not download binaries`,
        );
      }

      const raw = await response.text();
      const truncated = raw.length > maxBytes;
      const text = truncated ? raw.slice(0, maxBytes) : raw;

      return {
        output: {
          status: response.status,
          ok: response.ok,
          contentType,
          finalUrl: response.url,
          truncated,
          text,
        },
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ToolError(
          "EXECUTION_FAILED",
          "http_fetch",
          `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
          { cause: error },
        );
      }
      throw new ToolError(
        "EXECUTION_FAILED",
        "http_fetch",
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  },
};
