/**
 * Shared error types that map cleanly onto HTTP responses.
 *
 * Domain modules throw these (or their own richer subclasses like
 * HarnessValidationError); route handlers only translate them — they never
 * inspect message strings.
 */

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have access to this resource") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Resource already exists") {
    super(message);
    this.name = "ConflictError";
  }
}

export interface ValidationIssueLike {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/** Generic 400 with structured issues (harness graphs, form input, imports). */
export class ValidationFailedError extends Error {
  public readonly issues: ValidationIssueLike[];

  constructor(message: string, issues: ValidationIssueLike[] = []) {
    super(message);
    this.name = "ValidationFailedError";
    this.issues = issues;
  }
}
