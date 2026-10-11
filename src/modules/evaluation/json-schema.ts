/**
 * A small, dependency-free JSON Schema validator.
 *
 * Why not a library: evaluation output is untrusted data and the schema comes
 * from a developer, so the validator has to be *predictable*. This module
 * implements a documented subset of JSON Schema (draft 2020-12 keywords) and
 * refuses — loudly — to accept a schema that uses a structural keyword it does
 * not implement. That refusal is the important part: JSON Schema semantics say
 * unknown keywords are ignored, so silently accepting `patternProperties` or
 * `$ref` would turn a strict schema into one that passes everything.
 *
 * Supported keywords
 *   type, enum, const
 *   properties, required, additionalProperties
 *   items, prefixItems, minItems, maxItems, uniqueItems
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf
 *   minLength, maxLength, pattern
 *   anyOf, allOf, oneOf, not
 *   title, description, default, examples, $schema, $id, $comment (annotations)
 *
 * Deliberately unsupported (rejected as a configuration error):
 *   $ref/$dynamicRef/$recursiveRef, patternProperties, propertyNames,
 *   if/then/else, dependentRequired, dependentSchemas, unevaluated*,
 *   contentEncoding/contentMediaType, format assertions.
 */

export interface JsonSchemaIssue {
  /** JSON Pointer-ish path of the failing value: "" for the root. */
  path: string;
  /** Value shape that failed, e.g. "string", "number", "missing". */
  actual: string;
  message: string;
  keyword: string;
}

export type JsonSchema = Record<string, unknown> | boolean;

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  // annotations — accepted, never enforced
  "title",
  "description",
  "default",
  "examples",
  "$schema",
  "$id",
  "$comment",
]);

/** The JSON type names a `type` keyword may use. */
type JsonTypeName = "null" | "boolean" | "object" | "array" | "number" | "integer" | "string";

function typeOf(value: unknown): JsonTypeName {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/** `integer` matches integral numbers, so a JSON `1` satisfies both. */
function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === expected;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || typeof a !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
  );
}

/**
 * Keywords whose values are *data*, not schemas — walking into them would
 * mistake a property name for an unsupported keyword.
 */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "title", "description", "$comment", "$schema", "$id"]);

/** Keywords whose values are schemas keyed by an arbitrary name. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions"]);

/** Keywords whose values are schemas in a list. */
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/**
 * Structural keywords this validator does not implement, found anywhere in the
 * schema. An evaluator must refuse such a schema rather than validate with a
 * keyword silently dropped — an ignored `patternProperties` would turn a strict
 * schema into one that accepts anything.
 */
export function unsupportedKeywords(schema: unknown): string[] {
  const found = new Set<string>();

  const walkSchema = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (DATA_KEYWORDS.has(key)) {
        continue;
      }
      if (SCHEMA_MAP_KEYWORDS.has(key)) {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          for (const child of Object.values(value as Record<string, unknown>)) {
            walkSchema(child);
          }
        }
        continue;
      }
      if (SCHEMA_LIST_KEYWORDS.has(key)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            walkSchema(child);
          }
        }
        continue;
      }
      if (!SUPPORTED_KEYWORDS.has(key)) {
        found.add(key);
        continue;
      }
      // A supported keyword may still hold a subschema (`items`, `not`, …).
      walkSchema(value);
    }
  };

  walkSchema(schema);
  return [...found].sort();
}

interface ValidateState {
  issues: JsonSchemaIssue[];
  maxIssues: number;
  depth: number;
}

function push(state: ValidateState, issue: JsonSchemaIssue): void {
  if (state.issues.length < state.maxIssues) {
    state.issues.push(issue);
  }
}

function validateNode(schema: JsonSchema, value: unknown, path: string, state: ValidateState): void {
  if (state.issues.length >= state.maxIssues || state.depth > 64) {
    return;
  }
  if (schema === true) {
    return;
  }
  if (schema === false) {
    push(state, {
      path,
      actual: typeOf(value),
      message: "no value is allowed here (schema is false)",
      keyword: "false",
    });
    return;
  }
  const node = schema as Record<string, unknown>;

  if (Array.isArray(node["type"])) {
    const allowed = node["type"].filter((entry): entry is string => typeof entry === "string");
    if (!allowed.some((entry) => matchesType(value, entry))) {
      push(state, {
        path,
        actual: typeOf(value),
        message: `expected ${allowed.join(" | ")}, got ${typeOf(value)}`,
        keyword: "type",
      });
      return;
    }
  } else if (typeof node["type"] === "string") {
    if (!matchesType(value, node["type"])) {
      push(state, {
        path,
        actual: typeOf(value),
        message: `expected ${node["type"]}, got ${typeOf(value)}`,
        keyword: "type",
      });
      return;
    }
  }

  if (Array.isArray(node["enum"])) {
    const options = node["enum"] as unknown[];
    if (!options.some((option) => deepEqual(option, value))) {
      push(state, {
        path,
        actual: typeOf(value),
        message: `value is not one of the ${options.length} allowed option(s)`,
        keyword: "enum",
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(node, "const")) {
    if (!deepEqual(node["const"], value)) {
      push(state, { path, actual: typeOf(value), message: "value does not equal the required constant", keyword: "const" });
    }
  }

  if (typeof value === "number") {
    const bounds: Array<[string, (bound: number) => boolean, string]> = [
      ["minimum", (bound) => value >= bound, "at least"],
      ["maximum", (bound) => value <= bound, "at most"],
      ["exclusiveMinimum", (bound) => value > bound, "greater than"],
      ["exclusiveMaximum", (bound) => value < bound, "less than"],
    ];
    for (const [keyword, check, phrase] of bounds) {
      const bound = node[keyword];
      if (typeof bound === "number" && !check(bound)) {
        push(state, {
          path,
          actual: String(value),
          message: `must be ${phrase} ${bound}`,
          keyword,
        });
      }
    }
    const multipleOf = node["multipleOf"];
    if (typeof multipleOf === "number" && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        push(state, {
          path,
          actual: String(value),
          message: `must be a multiple of ${multipleOf}`,
          keyword: "multipleOf",
        });
      }
    }
  }

  if (typeof value === "string") {
    const minLength = node["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      push(state, {
        path,
        actual: `${value.length} characters`,
        message: `must be at least ${minLength} characters`,
        keyword: "minLength",
      });
    }
    const maxLength = node["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      push(state, {
        path,
        actual: `${value.length} characters`,
        message: `must be at most ${maxLength} characters`,
        keyword: "maxLength",
      });
    }
    const pattern = node["pattern"];
    if (typeof pattern === "string") {
      try {
        if (!new RegExp(pattern).test(value)) {
          push(state, {
            path,
            actual: `"${value.slice(0, 40)}"`,
            message: `must match /${pattern}/`,
            keyword: "pattern",
          });
        }
      } catch {
        push(state, {
          path,
          actual: "invalid pattern",
          message: `pattern /${pattern}/ is not a valid regular expression`,
          keyword: "pattern",
        });
      }
    }
  }

  if (Array.isArray(value)) {
    const prefixItems = node["prefixItems"];
    if (Array.isArray(prefixItems)) {
      prefixItems.forEach((childSchema, index) => {
        if (index < value.length) {
          state.depth += 1;
          validateNode(childSchema as JsonSchema, value[index], `${path}/${index}`, state);
          state.depth -= 1;
        }
      });
    }
    const items = node["items"];
    const restStart = Array.isArray(prefixItems) ? prefixItems.length : 0;
    if (typeof items === "object" && items !== null) {
      for (let index = restStart; index < value.length; index += 1) {
        state.depth += 1;
        validateNode(items as JsonSchema, value[index], `${path}/${index}`, state);
        state.depth -= 1;
      }
    }
    const minItems = node["minItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      push(state, {
        path,
        actual: `${value.length} items`,
        message: `must have at least ${minItems} items`,
        keyword: "minItems",
      });
    }
    const maxItems = node["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      push(state, {
        path,
        actual: `${value.length} items`,
        message: `must have at most ${maxItems} items`,
        keyword: "maxItems",
      });
    }
    if (node["uniqueItems"] === true && value.length <= 200) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            push(state, {
              path: `${path}/${j}`,
              actual: "duplicate",
              message: `items must be unique (duplicate of index ${i})`,
              keyword: "uniqueItems",
            });
          }
        }
      }
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = node["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(record, key)) {
          push(state, {
            path: path === "" ? `/${key}` : `${path}/${key}`,
            actual: "missing",
            message: `required property "${key}" is missing`,
            keyword: "required",
          });
        }
      }
    }
    const properties = node["properties"];
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          state.depth += 1;
          validateNode(childSchema as JsonSchema, record[key], `${path}/${key}`, state);
          state.depth -= 1;
        }
      }
    }
    const additional = node["additionalProperties"];
    if (additional === false && properties !== null && typeof properties === "object") {
      const allowed = new Set(Object.keys(properties as Record<string, unknown>));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          push(state, {
            path: `${path}/${key}`,
            actual: typeOf(record[key]),
            message: `property "${key}" is not allowed (additionalProperties: false)`,
            keyword: "additionalProperties",
          });
        }
      }
    }
  }

  // Combinators: a nested validation runs against a throwaway state so
  // sub-issues cannot leak into the parent's report.
  const runSubSchema = (childSchema: JsonSchema, current: unknown): JsonSchemaIssue[] => {
    const sub: ValidateState = { issues: [], maxIssues: state.maxIssues, depth: state.depth + 1 };
    validateNode(childSchema, current, path, sub);
    return sub.issues;
  };

  if (Array.isArray(node["allOf"])) {
    for (const childSchema of node["allOf"] as unknown[]) {
      for (const issue of runSubSchema(childSchema as JsonSchema, value)) {
        push(state, issue);
      }
    }
  }

  if (Array.isArray(node["anyOf"])) {
    const branches = node["anyOf"] as unknown[];
    const passes = branches.some((childSchema) => runSubSchema(childSchema as JsonSchema, value).length === 0);
    if (!passes) {
      push(state, {
        path,
        actual: typeOf(value),
        message: `must match at least one of the ${branches.length} anyOf branches`,
        keyword: "anyOf",
      });
    }
  }

  if (Array.isArray(node["oneOf"])) {
    const branches = node["oneOf"] as unknown[];
    const matches = branches.filter(
      (childSchema) => runSubSchema(childSchema as JsonSchema, value).length === 0,
    ).length;
    if (matches !== 1) {
      push(state, {
        path,
        actual: typeOf(value),
        message: `must match exactly one of the ${branches.length} oneOf branches (matched ${matches})`,
        keyword: "oneOf",
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(node, "not")) {
    if (runSubSchema(node["not"] as JsonSchema, value).length === 0) {
      push(state, { path, actual: typeOf(value), message: "must not match the given schema", keyword: "not" });
    }
  }
}

export interface JsonSchemaValidationResult {
  valid: boolean;
  issues: JsonSchemaIssue[];
}

/** Validates `value` against `schema`. Never throws for data problems. */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  options: { maxIssues?: number } = {},
): JsonSchemaValidationResult {
  const state: ValidateState = { issues: [], maxIssues: options.maxIssues ?? 25, depth: 0 };
  validateNode(schema, value, "", state);
  return { valid: state.issues.length === 0, issues: state.issues };
}

/** Human-readable one-liner for the first N issues. */
export function describeIssues(issues: JsonSchemaIssue[], limit = 3): string {
  return issues
    .slice(0, limit)
    .map((issue) => `${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`)
    .join("; ");
}
