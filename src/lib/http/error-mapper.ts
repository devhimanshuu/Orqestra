import { ZodError } from "zod";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationFailedError,
} from "@/lib/errors";
import { AgentInputError, AgentNotFoundError } from "@/modules/agents/agent.types";
import {
  HarnessConflictError,
  HarnessNotFoundError,
  HarnessValidationError,
} from "@/modules/harness/harness.types";
import { logger } from "@/lib/logging/logger";
import { jsonError } from "./api-response";

/**
 * Single place that turns thrown domain errors into HTTP responses, so route
 * handlers stay three lines long and error shapes stay consistent:
 *
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return jsonError(
      400,
      "VALIDATION_FAILED",
      "Request validation failed",
      error.issues.map((issue) => ({
        code: "INVALID_INPUT",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    );
  }

  if (error instanceof HarnessValidationError) {
    return jsonError(400, "HARNESS_INVALID", error.message, error.issues);
  }

  if (error instanceof ValidationFailedError) {
    return jsonError(400, "VALIDATION_FAILED", error.message, error.issues);
  }

  if (error instanceof AgentInputError) {
    return jsonError(400, "INVALID_INPUT", error.message);
  }

  if (error instanceof UnauthorizedError) {
    return jsonError(401, "UNAUTHORIZED", error.message);
  }

  if (error instanceof ForbiddenError) {
    return jsonError(403, "FORBIDDEN", error.message);
  }

  if (
    error instanceof NotFoundError ||
    error instanceof HarnessNotFoundError ||
    error instanceof AgentNotFoundError
  ) {
    return jsonError(404, "NOT_FOUND", error.message);
  }

  if (error instanceof ConflictError || error instanceof HarnessConflictError) {
    return jsonError(409, "CONFLICT", error.message);
  }

  logger.error("unhandled API error", {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : typeof error,
  });
  return jsonError(500, "INTERNAL_ERROR", "Something went wrong on our side");
}
