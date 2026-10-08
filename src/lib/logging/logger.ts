/**
 * Structured server-side logger.
 *
 * Emits one JSON object per line to stdout — grep-able and ingestible by any
 * log pipeline. No console.* calls in production code; no dependencies.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redact(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2_000) {
    return `${value.slice(0, 2_000)}…`;
  }
  return value;
}

function emit(level: LogLevel, context: LogFields, message: string, fields?: LogFields): void {
  if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[resolveLevel()]) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(redact(context) as LogFields),
    ...(fields ? (redact(fields) as LogFields) : {}),
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function createLogger(context: LogFields = {}): Logger {
  return {
    debug: (message, fields) => emit("debug", context, message, fields),
    info: (message, fields) => emit("info", context, message, fields),
    warn: (message, fields) => emit("warn", context, message, fields),
    error: (message, fields) => emit("error", context, message, fields),
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

/** Root application logger. Prefer `logger.child({ module: ... })` in modules. */
export const logger = createLogger({ app: "orqestra" });
