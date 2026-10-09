import {
  HARNESS_SCHEMA_VERSION,
  getHandleSpec,
  harnessDefinitionSchema,
  harnessDraftDocumentSchema,
  harnessNodeSchema,
  type HarnessDefinition,
  type HarnessEdge,
  type HarnessNode,
} from "./harness.schema";
import { upgradeHarnessDefinition } from "./harness.migrate";

/**
 * Harness graph validation.
 *
 * Structural validation (Zod) plus the graph rules that make a harness
 * *executable and terminating*:
 *
 *  A. schema conformance            unknown node type / config key → INVALID_SCHEMA
 *  B. identity & handles            unique ids, known endpoints, valid handles,
 *                                   exactly one start node, at least one end node,
 *                                   entryNode === start, exitNodes === end nodes,
 *                                   no incoming edges into start
 *  C. connectivity & termination     every node reachable from start, every node
 *                                   able to reach an end node, no dead ends,
 *                                   end nodes are terminal, conditions expose both
 *                                   branches, and every cycle passes through a
 *                                   loop node
 *
 * Cycles are allowed only when a `loop` node participates — an accidental cycle
 * is almost always a modelling bug, and the runtime (Phase 2) needs a bounded
 * iteration count from the loop node to guarantee termination.
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
  /** Phase 2 runtime additions: a node cannot run, or its config is unusable. */
  | "NODE_NOT_EXECUTABLE"
  | "NODE_CONFIG_INVALID";

export interface HarnessValidationIssue {
  code: HarnessValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export type HarnessValidationResult =
  | { ok: true; definition: HarnessDefinition; issues: [] }
  | { ok: false; definition: null; issues: HarnessValidationIssue[] };

function adjacency(definition: HarnessDefinition): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of definition.nodes) {
    map.set(node.id, []);
  }
  for (const edge of definition.edges) {
    map.get(edge.source)?.push(edge.target);
  }
  return map;
}

/** Breadth-first reachability from a set of starting nodes over the given graph. */
function reachableFrom(starts: Iterable<string>, graph: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }
  return visited;
}

/**
 * Tarjan's strongly connected components — used to find every cycle, including
 * cycles nested inside larger loops of the graph.
 */
function stronglyConnectedComponents(nodes: string[], graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  // Iterative Tarjan to avoid stack overflows on large graphs.
  for (const root of nodes) {
    if (index.has(root)) {
      continue;
    }
    const work: Array<{ node: string; edges: string[]; next: number }> = [
      { node: root, edges: graph.get(root) ?? [], next: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; edges: string[]; next: number };
      if (frame.next < frame.edges.length) {
        const child = frame.edges[frame.next] as string;
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, edges: graph.get(child) ?? [], next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(child) as number));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop() as string;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) {
            break;
          }
        }
        components.push(component);
      }
    }
  }
  return components;
}

function schemaIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): HarnessValidationIssue[] {
  return error.issues.map((issue) => ({
    code: "INVALID_SCHEMA" as const,
    message: `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
  }));
}

/**
 * Validates a *published* harness definition — the strict envelope, where
 * `id`/`version`/`entryNode`/`exitNodes` are all present. Used for publishing,
 * importing and anywhere a complete definition is expected.
 */
export function validateHarnessDefinition(input: unknown): HarnessValidationResult {
  const upgraded = upgradeHarnessDefinition(input);
  const parsed = harnessDefinitionSchema.safeParse(upgraded);
  if (!parsed.success) {
    return { ok: false, definition: null, issues: schemaIssues(parsed.error) };
  }
  return runGraphChecks(parsed.data);
}

/**
 * Validates a *draft* document — what the builder holds while editing, and
 * what autosave stores.
 *
 * Drafts are the common case: `id`/`version` are assigned at publish time, and
 * entry/exit are derived from the Start/End nodes when absent. Validating a
 * draft with the published envelope would report envelope complaints
 * (`id: expected string`) instead of the graph problems the editor exists to
 * surface — every draft would look invalid.
 */
export function validateHarnessDraft(input: unknown): HarnessValidationResult {
  const upgraded = upgradeHarnessDefinition(input);
  const parsed = harnessDraftDocumentSchema.safeParse(upgraded);
  if (!parsed.success) {
    return { ok: false, definition: null, issues: schemaIssues(parsed.error) };
  }

  const draft = parsed.data;
  const startNode = draft.nodes.find((node) => node.type === "start");
  const exitNodes = draft.nodes.filter((node) => node.type === "end").map((node) => node.id);
  const definition = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: draft.id ?? "draft",
    version: draft.version ?? 1,
    name: draft.name ?? "Untitled harness",
    ...(draft.description === undefined ? {} : { description: draft.description }),
    nodes: draft.nodes,
    edges: draft.edges,
    entryNode: draft.entryNode ?? startNode?.id ?? "",
    exitNodes: draft.exitNodes ?? exitNodes,
  } as HarnessDefinition;

  // Draft configs are stored loosely so a half-typed value never blocks
  // editing, but typos and wrong types must still be reported: `harnessNodeSchema`
  // is the same authority that runs at publish time, so the editor and the
  // publish gate agree on what is wrong.
  const configIssues: HarnessValidationIssue[] = [];
  for (const node of definition.nodes) {
    const parsedNode = harnessNodeSchema.safeParse(node);
    if (parsedNode.success) {
      continue;
    }
    for (const issue of parsedNode.error.issues) {
      const path = issue.path.map(String).join(".");
      configIssues.push({
        code: "INVALID_SCHEMA",
        message: `${node.id}.${path || "(root)"}: ${issue.message}`,
        nodeId: node.id,
      });
    }
  }

  const result = runGraphChecks(definition);
  if (configIssues.length === 0) {
    return result;
  }
  return { ok: false, definition: null, issues: [...configIssues, ...result.issues] };
}

/** Graph rules shared by drafts and published definitions. */
function runGraphChecks(definition: HarnessDefinition): HarnessValidationResult {
  const issues: HarnessValidationIssue[] = [];
  const nodeById = new Map<string, HarnessNode>();

  // --- A. identity -----------------------------------------------------------
  for (const node of definition.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
    }
    nodeById.set(node.id, node);
  }

  const seenEdgeIds = new Set<string>();
  const seenEndpoints = new Set<string>();
  for (const edge of definition.edges) {
    if (seenEdgeIds.has(edge.id)) {
      issues.push({
        code: "DUPLICATE_EDGE_ID",
        message: `Duplicate edge id "${edge.id}"`,
        edgeId: edge.id,
      });
    }
    seenEdgeIds.add(edge.id);

    const endpoints = `${edge.source}->${edge.target}`;
    if (seenEndpoints.has(endpoints)) {
      issues.push({
        code: "DUPLICATE_EDGE_ID",
        message: `Duplicate edge from "${edge.source}" to "${edge.target}"`,
        edgeId: edge.id,
      });
    }
    seenEndpoints.add(endpoints);
  }

  // --- B. endpoints, handles, control nodes ---------------------------------
  for (const edge of definition.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);

    if (source === undefined) {
      issues.push({
        code: "EDGE_UNKNOWN_SOURCE",
        message: `Edge "${edge.id}" references unknown source node "${edge.source}"`,
        edgeId: edge.id,
        nodeId: edge.source,
      });
    } else {
      const spec = getHandleSpec(source.type);
      const handle = edge.sourceHandle ?? "";
      if (spec.outputs.length === 0 || !spec.outputs.includes(handle)) {
        issues.push({
          code: "EDGE_INVALID_HANDLE",
          message:
            spec.outputs.length === 0
              ? `Node "${source.id}" (${source.type}) has no outputs but edge "${edge.id}" leaves it`
              : `Edge "${edge.id}" uses unknown branch "${handle || "(none)"}" on node "${source.id}" (${source.type}) — expected one of: ${spec.outputs.filter(Boolean).join(", ") || "(default)"}`,
          edgeId: edge.id,
          nodeId: source.id,
        });
      }
    }

    if (target === undefined) {
      issues.push({
        code: "EDGE_UNKNOWN_TARGET",
        message: `Edge "${edge.id}" references unknown target node "${edge.target}"`,
        edgeId: edge.id,
        nodeId: edge.target,
      });
    } else if (!getHandleSpec(target.type).input) {
      issues.push({
        code: "EDGE_INTO_START",
        message: `Edge "${edge.id}" targets "${target.id}" (${target.type}) which accepts no input`,
        edgeId: edge.id,
        nodeId: target.id,
      });
    }
  }

  const startNodes = definition.nodes.filter((node) => node.type === "start");
  const endNodes = definition.nodes.filter((node) => node.type === "end");

  if (startNodes.length === 0) {
    issues.push({ code: "MISSING_START_NODE", message: "Harness has no Start node" });
  } else if (startNodes.length > 1) {
    for (const node of startNodes.slice(1)) {
      issues.push({
        code: "DUPLICATE_START_NODE",
        message: `Harness has more than one Start node ("${node.id}")`,
        nodeId: node.id,
      });
    }
  }

  if (endNodes.length === 0) {
    issues.push({ code: "MISSING_END_NODE", message: "Harness has no End node" });
  }

  const startNode = startNodes[0];
  if (startNode !== undefined && definition.entryNode !== startNode.id) {
    issues.push({
      code: "ENTRY_NOT_START",
      message: `entryNode "${definition.entryNode}" must be the Start node "${startNode.id}"`,
      nodeId: definition.entryNode,
    });
  } else if (
    startNode === undefined &&
    // Drafts derive an empty entryNode when the graph has no Start node yet;
    // MISSING_START_NODE above already reports that, so don't double-report.
    definition.entryNode !== "" &&
    !nodeById.has(definition.entryNode)
  ) {
    issues.push({
      code: "MISSING_ENTRY_NODE",
      message: `entryNode "${definition.entryNode}" does not exist`,
      nodeId: definition.entryNode,
    });
  }

  const exitSet = new Set<string>();
  for (const exitNodeId of definition.exitNodes) {
    if (exitSet.has(exitNodeId)) {
      issues.push({
        code: "DUPLICATE_EXIT_NODE",
        message: `exitNode "${exitNodeId}" is listed more than once`,
        nodeId: exitNodeId,
      });
    }
    exitSet.add(exitNodeId);

    const node = nodeById.get(exitNodeId);
    if (node === undefined) {
      issues.push({
        code: "MISSING_EXIT_NODE",
        message: `exitNode "${exitNodeId}" does not exist`,
        nodeId: exitNodeId,
      });
    } else if (node.type !== "end") {
      issues.push({
        code: "EXIT_NOT_END",
        message: `Exit node "${exitNodeId}" is a ${node.type} node — exit nodes must be End nodes`,
        nodeId: exitNodeId,
      });
    }
  }

  for (const endNode of endNodes) {
    if (!exitSet.has(endNode.id)) {
      issues.push({
        code: "EXIT_NODE_MISMATCH",
        message: `End node "${endNode.id}" is missing from exitNodes`,
        nodeId: endNode.id,
      });
    }
  }

  if (issues.length > 0) {
    // Graph rules below assume structural integrity; report what we have.
    return { ok: false, definition: null, issues };
  }

  const graph = adjacency(definition);
  const reverseGraph = new Map<string, string[]>();
  for (const node of definition.nodes) {
    reverseGraph.set(node.id, []);
  }
  for (const edge of definition.edges) {
    reverseGraph.get(edge.target)?.push(edge.source);
  }

  // --- C. connectivity -------------------------------------------------------
  const reachable = reachableFrom([definition.entryNode], graph);
  for (const node of definition.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({
        code: "UNREACHABLE_NODE",
        message: `Node "${node.id}" is unreachable from Start`,
        nodeId: node.id,
      });
    }
  }

  const canFinish = reachableFrom(definition.exitNodes, reverseGraph);
  for (const node of definition.nodes) {
    if (!canFinish.has(node.id)) {
      issues.push({
        code: "NO_PATH_TO_END",
        message: `Node "${node.id}" has no path to an End node`,
        nodeId: node.id,
      });
    }
  }

  // --- D. termination shape --------------------------------------------------
  const outgoing = new Map<string, number>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  for (const node of definition.nodes) {
    const outDegree = outgoing.get(node.id) ?? 0;
    if (node.type === "end") {
      if (outDegree > 0) {
        issues.push({
          code: "NON_TERMINAL_END_NODE",
          message: `End node "${node.label}" has outgoing edges but must be terminal`,
          nodeId: node.id,
        });
      }
      continue;
    }
    if (outDegree === 0) {
      issues.push({
        code: "DEAD_END_NODE",
        message: `Node "${node.label}" has no outgoing edges — connect it to an End node`,
        nodeId: node.id,
      });
    }
  }

  // --- E. branching ----------------------------------------------------------
  for (const node of definition.nodes) {
    if (node.type !== "condition") {
      continue;
    }
    const branches = new Set(
      definition.edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => edge.sourceHandle ?? ""),
    );
    for (const required of getHandleSpec("condition").outputs) {
      if (!branches.has(required)) {
        issues.push({
          code: "CONDITION_MISSING_BRANCH",
          message: `Condition "${node.label}" is missing the "${required}" branch`,
          nodeId: node.id,
        });
      }
    }
  }

  // --- F. cycles must be explicit -------------------------------------------
  const nodeIds = definition.nodes.map((node) => node.id);
  for (const component of stronglyConnectedComponents(nodeIds, graph)) {
    const isCycle =
      component.length > 1 ||
      (component.length === 1 &&
        (graph.get(component[0] as string) ?? []).includes(component[0] as string));
    if (!isCycle) {
      continue;
    }
    const hasLoop = component.some((id) => nodeById.get(id)?.type === "loop");
    if (!hasLoop) {
      for (const id of component) {
        const node = nodeById.get(id);
        issues.push({
          code: "UNDECLARED_CYCLE",
          message: `Node "${node?.label ?? id}" is part of a cycle with no Loop node — use a Loop node to repeat behavior`,
          nodeId: id,
        });
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, definition: null, issues };
  }
  return { ok: true, definition, issues: [] };
}

/** Convenience guard for narrowing in services. */
export function isValidHarnessDefinition(input: unknown): input is HarnessDefinition {
  return validateHarnessDefinition(input).ok;
}

/** Groups issues by node id (unassigned issues under the empty key) for editor decoration. */
export function groupIssuesByNode(
  issues: HarnessValidationIssue[],
): Map<string, HarnessValidationIssue[]> {
  const map = new Map<string, HarnessValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.nodeId ?? "";
    const bucket = map.get(key) ?? [];
    bucket.push(issue);
    map.set(key, bucket);
  }
  return map;
}

export type { HarnessDefinition, HarnessEdge, HarnessNode };
