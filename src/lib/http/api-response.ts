import type { ApiErrorBody } from "@/types/api";

/** JSON success/partial response. */
export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** JSON error response using the shared envelope. Never includes secrets. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return Response.json(body, { status });
}
