/**
 * Structured-output parsing.
 *
 * Planner/Critic/Evaluator nodes require JSON. Models are asked for JSON, but
 * they still wrap it in prose or fences, so we extract the first *balanced*
 * JSON value rather than trusting the whole response. Nothing here executes
 * code: it scans characters and calls JSON.parse on the extracted slice.
 */

import { ValidationError } from "../errors/runtime-error";

function findBalanced(source: string, openIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts the first JSON object/array from model text.
 * Returns null when nothing parseable is found — callers decide whether that is
 * a repairable model glitch (one retry) or a hard failure.
 */
export function extractJsonValue(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }

  // Fenced block first: ```json { … } ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fence?.[1] !== undefined ? [fence[1], trimmed] : [trimmed];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to balanced extraction.
    }
    const objectStart = candidate.indexOf("{");
    const arrayStart = candidate.indexOf("[");
    const start =
      objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
    if (start === -1) {
      continue;
    }
    const slice = findBalanced(candidate, start);
    if (slice === null) {
      continue;
    }
    try {
      return JSON.parse(slice);
    } catch {
      continue;
    }
  }
  return null;
}

/** Parses model text into a JSON object or throws a ValidationError. */
export function requireJsonObject(text: string, context: string): Record<string, unknown> {
  const parsed = extractJsonValue(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(`${context} did not return a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Clamps a number read from model JSON into [min, max]; null when unusable. */
export function readNumberField(
  record: Record<string, unknown>,
  keys: readonly string[],
  options: { min?: number; max?: number } = {},
): number | null {
  for (const key of keys) {
    const value = record[key];
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
          ? Number(value)
          : null;
    if (numeric !== null) {
      const min = options.min ?? Number.NEGATIVE_INFINITY;
      const max = options.max ?? Number.POSITIVE_INFINITY;
      return Math.min(Math.max(numeric, min), max);
    }
  }
  return null;
}

/** Reads a string list from model JSON, tolerating a single string. */
export function readStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
    }
    if (typeof value === "string" && value.trim() !== "") {
      return [value];
    }
  }
  return [];
}

/** Reads a string field, tolerating numbers/booleans. */
export function readTextField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}
