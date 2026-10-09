/**
 * Browser API client.
 *
 * One place that knows how Orqestra's JSON envelope works (`src/lib/http/*`),
 * so components never hand-roll fetch calls or parse error shapes themselves.
 * Server components read through the domain services instead of this module.
 */

/**
 * Validation issue shape returned by the API. The code is a fixed set on the
 * server (`HarnessValidationCode`); we mirror it here so client components can
 * pass issues straight into the editor store without casting.
 */
export type HarnessValidationCode =
  | "INVALID_SCHEMA"
  | "DUPLICATE_NODE_ID"
  | "DUPLICATE_EDGE_ID"
  | "EDGE_UNKNOWN_SOURCE"
  | "EDGE_UNKNOWN_TARGET"
  | "EDGE_INVALID_HANDLE"
  | "EDGE_INTO_START"
  | "MISSING_START_NODE"
  | "DUPLICATE_START_NODE"
  | "MISSING_ENTRY_NODE"
  | "ENTRY_NOT_START"
  | "MISSING_END_NODE"
  | "MISSING_EXIT_NODE"
  | "DUPLICATE_EXIT_NODE"
  | "EXIT_NOT_END"
  | "EXIT_NODE_MISMATCH"
  | "UNREACHABLE_NODE"
  | "NO_PATH_TO_END"
  | "DEAD_END_NODE"
  | "NON_TERMINAL_END_NODE"
  | "CONDITION_MISSING_BRANCH"
  | "UNDECLARED_CYCLE"
  // Runtime compilation adds these: a node cannot execute, or its config is invalid.
  | "NODE_NOT_EXECUTABLE"
  | "NODE_CONFIG_INVALID";

export interface ApiIssue {
  code: HarnessValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly issues: ApiIssue[];

  constructor(status: number, code: string, message: string, issues: ApiIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Json = Record<string, unknown>;

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: { issues?: ApiIssue[] } };
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });

  const text = await response.text();
  const payload: unknown = text ? safeJsonParse(text) : {};

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const code = envelope.error?.code ?? "UNKNOWN";
    const message = envelope.error?.message ?? `Request failed with status ${response.status}`;
    const issues = envelope.error?.details?.issues ?? [];
    throw new ApiError(response.status, code, message, issues);
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text } satisfies Json;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: "POST", json }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: "PUT", json }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: "PATCH", json }),
  delete: <T>(path: string, json?: unknown) => request<T>(path, { method: "DELETE", json }),
};

/** Message for a failed request, counting validation issues when the server sent any. */
export function errorMessageWithIssues(error: unknown): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    const count = error.issues.length;
    return `${error.message} (${count} validation problem${count === 1 ? "" : "s"})`;
  }
  return errorMessage(error);
}

/** Human-readable message for anything thrown by the client. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected error";
}
