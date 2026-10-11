import { describe, expect, it } from "vitest";
import {
  MAX_DATASET_CASES,
  buildDatasetExport,
  jsonSizeBytes,
  parseDatasetImport,
  toExportCase,
} from "./dataset.schema";

const validDataset = {
  name: "Arithmetic",
  description: "Basic checks",
  cases: [
    { caseKey: "sum-1", input: "What is 2 + 2?", expectedOutput: "4", tags: ["math"] },
    { caseKey: "sum-2", input: "What is 10 - 4?", expectedOutput: "6" },
  ],
};

describe("parseDatasetImport", () => {
  it("accepts a well-formed dataset", () => {
    const result = parseDatasetImport(validDataset);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataset.cases).toHaveLength(2);
      expect(result.dataset.cases[0]?.caseKey).toBe("sum-1");
    }
  });

  it("accepts nested JSON inputs and expected outputs", () => {
    const result = parseDatasetImport({
      name: "Structured",
      cases: [
        {
          caseKey: "json-1",
          input: { question: "list", options: ["a", "b"], nested: { deep: [1, 2, { x: null }] } },
          expectedOutput: { answer: "a", score: 1 },
          metadata: { owner: "eval-team" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("reports every problem with a path instead of stopping at the first", () => {
    const result = parseDatasetImport({
      name: "",
      cases: [
        { caseKey: "ok", input: "fine" },
        { caseKey: "bad key!", input: "nope" },
        { input: "missing key" },
        { caseKey: "ok", input: "duplicate" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain("name");
      expect(paths).toContain("cases.1.caseKey");
      expect(paths).toContain("cases.2.caseKey");
      expect(paths).toContain("cases.3.caseKey");
      expect(result.issues.some((issue) => issue.message.match(/Duplicate caseKey/))).toBe(true);
    }
  });

  it("rejects unknown fields (imported data must match the contract exactly)", () => {
    const result = parseDatasetImport({
      name: "Extra",
      cases: [{ caseKey: "a", input: "x", unexpected: true }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty case list and an oversized dataset", () => {
    expect(parseDatasetImport({ name: "Empty", cases: [] }).ok).toBe(false);

    const tooMany = {
      name: "Huge",
      cases: Array.from({ length: MAX_DATASET_CASES + 1 }, (_, index) => ({
        caseKey: `case-${index}`,
        input: "x",
      })),
    };
    const result = parseDatasetImport(tooMany);
    expect(result.ok).toBe(false);
  });

  it("rejects values that are not JSON", () => {
    // A Date instance cannot appear in a JSON file, so accepting it would mean
    // storing something the importer cannot round-trip. Reject it.
    const withDate = parseDatasetImport({
      name: "Bad",
      cases: [{ caseKey: "a", input: { when: new Date() } }],
    });
    expect(withDate.ok).toBe(false);

    const withFunction = parseDatasetImport({
      name: "Bad",
      cases: [{ caseKey: "a", input: () => "x" }],
    });
    expect(withFunction.ok).toBe(false);

    // JSON-representable values — including an ISO date string — are fine.
    expect(
      parseDatasetImport({ name: "Good", cases: [{ caseKey: "a", input: { when: "2026-01-01" } }] }).ok,
    ).toBe(true);
  });

  it("never throws on arbitrary input", () => {
    for (const value of [null, 42, "text", [], { name: 1, cases: "no" }]) {
      expect(() => parseDatasetImport(value)).not.toThrow();
      expect(parseDatasetImport(value).ok).toBe(false);
    }
  });
});

describe("export", () => {
  it("round-trips through the importer without losing cases", () => {
    const document = buildDatasetExport({
      id: "dataset-1",
      name: "Round trip",
      description: null,
      version: 3,
      now: new Date("2026-01-01T00:00:00Z"),
      cases: [
        {
          caseKey: "a",
          name: "A case",
          input: { q: "?" },
          expectedOutput: "answer",
          metadata: { source: "manual" },
          tags: ["smoke"],
        },
        { caseKey: "b", name: null, input: "plain", expectedOutput: null, metadata: null, tags: [] },
      ],
    });

    const reparsed = parseDatasetImport({
      name: document.dataset.name,
      cases: document.cases,
    });
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.dataset.cases.map((entry) => entry.caseKey)).toEqual(["a", "b"]);
      expect(reparsed.dataset.cases[0]).toMatchObject({
        input: { q: "?" },
        expectedOutput: "answer",
        tags: ["smoke"],
      });
    }
  });

  it("imports an exported document directly, keeping its provenance", () => {
    const document = buildDatasetExport({
      id: "dataset-9",
      name: "Exported corpus",
      description: "Round trip",
      version: 4,
      now: new Date("2026-01-01T00:00:00Z"),
      cases: [{ caseKey: "a", name: null, input: "x", expectedOutput: null, metadata: null, tags: [] }],
    });

    // The file the export route writes is the file the import route reads.
    const reparsed = parseDatasetImport(document);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.dataset.name).toBe("Exported corpus");
      expect(reparsed.dataset.datasetId).toBe("dataset-9");
      expect(reparsed.dataset.version).toBe(4);
      expect(reparsed.dataset.cases).toHaveLength(1);
    }
  });

  it("refuses an unknown export schemaVersion", () => {
    const result = parseDatasetImport({
      schemaVersion: 2,
      dataset: { id: "d", name: "Future", version: 1 },
      cases: [{ caseKey: "a", input: "x" }],
    });
    expect(result.ok).toBe(false);
  });

  it("omits absent optional fields rather than emitting nulls", () => {
    const exported = toExportCase({
      caseKey: "a",
      name: null,
      input: "x",
      expectedOutput: null,
      metadata: null,
      tags: [],
    });
    expect(exported).toEqual({ caseKey: "a", input: "x" });
  });

  it("measures serialised size safely", () => {
    expect(jsonSizeBytes({ a: 1 })).toBeGreaterThan(0);
    expect(jsonSizeBytes(undefined)).toBeNull();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(jsonSizeBytes(circular)).toBeNull();
  });
});
