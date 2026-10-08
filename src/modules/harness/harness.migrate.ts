import { HARNESS_SCHEMA_VERSION } from "./harness.schema";

/**
 * DSL migrations.
 *
 * Stored harness versions are immutable and keep their original
 * `schemaVersion`; readers upgrade old dialects in memory before validating.
 * v1 → v2: introduce explicit `start` / `end` control nodes (v1 relied on
 * `entryNode` / `exitNodes` alone).
 */

interface RawNode {
  id: string;
  type: string;
  label?: string;
  description?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

interface RawDefinition {
  schemaVersion?: number;
  entryNode?: string;
  exitNodes?: string[];
  nodes?: RawNode[];
  edges?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const START_ID = "start";

function positionOf(node: RawNode | undefined, fallback: { x: number; y: number }) {
  return node?.position ?? fallback;
}

function upgradeV1ToV2(definition: RawDefinition): RawDefinition {
  const nodes = Array.isArray(definition.nodes) ? [...definition.nodes] : [];
  const edges = Array.isArray(definition.edges) ? [...definition.edges] : [];
  const entryNode = typeof definition.entryNode === "string" ? definition.entryNode : undefined;
  const exitNodes = Array.isArray(definition.exitNodes)
    ? definition.exitNodes.filter((id): id is string => typeof id === "string")
    : [];

  const startNode: RawNode = {
    id: START_ID,
    type: "start",
    label: "Start",
    config: {},
    position: positionOf(
      nodes.find((node) => node.id === entryNode),
      { x: 0, y: 0 },
    ),
  };

  const endNodes = exitNodes.map((exitId, index) => {
    const source = nodes.find((node) => node.id === exitId);
    return {
      id: `end-${exitId}`,
      type: "end",
      label: "End",
      config: {},
      position: {
        x: positionOf(source, { x: index * 240, y: 0 }).x,
        y: positionOf(source, { x: 0, y: 0 }).y + 140,
      },
    } satisfies RawNode;
  });

  const startEdge = {
    id: `e-${START_ID}-${entryNode ?? "entry"}`,
    source: START_ID,
    target: entryNode ?? "",
  };
  const endEdges = exitNodes.map((exitId) => ({
    id: `e-${exitId}-end-${exitId}`,
    source: exitId,
    target: `end-${exitId}`,
  }));

  return {
    ...definition,
    schemaVersion: HARNESS_SCHEMA_VERSION,
    nodes: [startNode, ...nodes, ...endNodes],
    edges: [startEdge, ...edges, ...endEdges],
    entryNode: START_ID,
    exitNodes: endNodes.map((node) => node.id),
  };
}

/**
 * Upgrades any supported stored dialect to the current one.
 * Unknown/newer versions are returned untouched — schema validation reports them.
 */
export function upgradeHarnessDefinition(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const definition = input as RawDefinition;
  if (definition.schemaVersion === undefined || definition.schemaVersion === 1) {
    return upgradeV1ToV2(definition);
  }
  return input;
}
