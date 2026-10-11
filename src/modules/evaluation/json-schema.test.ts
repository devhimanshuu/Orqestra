import { describe, expect, it } from "vitest";
import {
  describeIssues,
  unsupportedKeywords,
  validateAgainstSchema,
  type JsonSchema,
} from "./json-schema";

describe("validateAgainstSchema", () => {
  it("accepts a value that satisfies the schema", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["answer", "confidence"],
      properties: {
        answer: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        sources: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
      additionalProperties: false,
    };
    const result = validateAgainstSchema(schema, {
      answer: "TypeScript adds static types.",
      confidence: 0.9,
      sources: ["https://example.com"],
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports the path and keyword of every failure", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["answer", "confidence"],
      properties: {
        answer: { type: "string" },
        confidence: { type: "number", maximum: 1 },
      },
      additionalProperties: false,
    };
    const result = validateAgainstSchema(schema, { confidence: 100, extra: true });
    expect(result.valid).toBe(false);
    const keywords = result.issues.map((issue) => issue.keyword);
    expect(keywords).toContain("required");
    expect(keywords).toContain("maximum");
    expect(keywords).toContain("additionalProperties");
    expect(result.issues.some((issue) => issue.path === "/confidence")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "/answer")).toBe(true);
    expect(describeIssues(result.issues)).toMatch(/confidence/);
  });

  it("distinguishes integer from number while accepting integral values", () => {
    expect(validateAgainstSchema({ type: "integer" }, 3).valid).toBe(true);
    expect(validateAgainstSchema({ type: "number" }, 3).valid).toBe(true);
    expect(validateAgainstSchema({ type: "integer" }, 3.5).valid).toBe(false);
  });

  it("supports type unions", () => {
    const schema: JsonSchema = { type: ["string", "null"] };
    expect(validateAgainstSchema(schema, "x").valid).toBe(true);
    expect(validateAgainstSchema(schema, null).valid).toBe(true);
    expect(validateAgainstSchema(schema, 1).valid).toBe(false);
  });

  it("compares enum and const by deep equality", () => {
    expect(validateAgainstSchema({ enum: [{ a: 1 }, "x"] }, { a: 1 }).valid).toBe(true);
    expect(validateAgainstSchema({ enum: [{ a: 1 }] }, { a: 2 }).valid).toBe(false);
    expect(validateAgainstSchema({ const: [1, 2] }, [1, 2]).valid).toBe(true);
  });

  it("validates patterns, lengths and multipleOf", () => {
    expect(validateAgainstSchema({ pattern: "^[a-z]+$" }, "abc").valid).toBe(true);
    expect(validateAgainstSchema({ pattern: "^[a-z]+$" }, "ABC").valid).toBe(false);
    expect(validateAgainstSchema({ minLength: 2, maxLength: 3 }, "abcd").valid).toBe(false);
    expect(validateAgainstSchema({ multipleOf: 3 }, 9).valid).toBe(true);
    expect(validateAgainstSchema({ multipleOf: 3 }, 10).valid).toBe(false);
  });

  it("reports an invalid pattern instead of throwing", () => {
    const result = validateAgainstSchema({ pattern: "([unclosed" }, "x");
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toMatch(/not a valid regular expression/);
  });

  it("enforces prefixItems and items together", () => {
    const schema: JsonSchema = {
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "boolean" },
    };
    expect(validateAgainstSchema(schema, ["a", 1, true]).valid).toBe(true);
    expect(validateAgainstSchema(schema, ["a", "b"]).valid).toBe(false);
    expect(validateAgainstSchema(schema, ["a", 1, "nope"]).valid).toBe(false);
  });

  it("detects non-unique array items", () => {
    expect(validateAgainstSchema({ type: "array", uniqueItems: true }, [1, 2, 1]).valid).toBe(false);
  });

  it("handles anyOf, allOf, oneOf and not", () => {
    expect(validateAgainstSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, 1).valid).toBe(true);
    expect(validateAgainstSchema({ anyOf: [{ type: "string" }] }, 1).valid).toBe(false);
    expect(
      validateAgainstSchema({ allOf: [{ type: "string" }, { minLength: 3 }] }, "ab").valid,
    ).toBe(false);
    expect(
      validateAgainstSchema({ oneOf: [{ type: "string" }, { type: "number" }] }, "x").valid,
    ).toBe(true);
    // matches both branches → oneOf fails
    expect(
      validateAgainstSchema({ oneOf: [{ type: "number" }, { minimum: 0 }] }, 5).valid,
    ).toBe(false);
    expect(validateAgainstSchema({ not: { type: "string" } }, 5).valid).toBe(true);
    expect(validateAgainstSchema({ not: { type: "string" } }, "s").valid).toBe(false);
  });

  it("treats boolean schemas literally", () => {
    expect(validateAgainstSchema(true, { anything: true }).valid).toBe(true);
    expect(validateAgainstSchema(false, "anything").valid).toBe(false);
  });

  it("bounds the number of reported issues", () => {
    const schema: JsonSchema = { type: "integer" };
    const result = validateAgainstSchema({ type: "array", items: schema }, [1.5, 2.5, 3.5], {
      maxIssues: 2,
    });
    expect(result.issues.length).toBe(2);
  });
});

describe("unsupportedKeywords", () => {
  it("returns nothing for the supported subset", () => {
    expect(
      unsupportedKeywords({
        type: "object",
        properties: { a: { type: "string", enum: ["x", "y"] } },
        required: ["a"],
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it("finds structural keywords that would silently weaken validation", () => {
    expect(unsupportedKeywords({ $ref: "#/definitions/a" })).toEqual(["$ref"]);
    expect(unsupportedKeywords({ patternProperties: { "^x": { type: "string" } } })).toEqual([
      "patternProperties",
    ]);
    expect(unsupportedKeywords({ if: { type: "string" }, then: { minLength: 1 } }).sort()).toEqual([
      "if",
      "then",
    ]);
    expect(unsupportedKeywords({ format: "email" })).toEqual(["format"]);
  });

  it("does not mistake data for schema keywords", () => {
    expect(unsupportedKeywords({ const: { someProperty: 1, another: true } })).toEqual([]);
    expect(unsupportedKeywords({ enum: [{ whatever: 1 }] })).toEqual([]);
    expect(unsupportedKeywords({ default: { notAKeyword: 1 } })).toEqual([]);
  });

  it("descends into nested subschemas", () => {
    expect(
      unsupportedKeywords({
        properties: { deep: { items: { $recursiveRef: "#" } } },
      }),
    ).toEqual(["$recursiveRef"]);
  });
});
