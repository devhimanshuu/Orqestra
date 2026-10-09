import type {
  HarnessDefinition,
  HarnessEdge,
  HarnessNode,
  HarnessNodeType,
} from "@/modules/harness/harness.schema";
import {
  validateHarnessDefinition,
  type HarnessValidationIssue,
} from "@/modules/harness/harness.validation";
import { hashHarnessDefinition } from "@/modules/harness/harness.serialize";
import { getToolRegistry } from "@/modules/tools";
import { nodeUnsupportedReason } from "./nodes/executability";
import { getNodeExecutorRegistry } from "./nodes/registry";
import type { RuntimeNode } from "./nodes/node-executor";
import { ValidationError } from "./errors/runtime-error";

/**
 * Harness compiler.
 *
 *   Harness definition → validation → executability checks → ExecutionPlan
 *
 * The plan is the runtime's *only* input: an immutable, adjacency-indexed view
 * of a validated definition, pinned to its content hash for reproducibility.
 * The runtime never re-reads the raw DSL document, and it never executes a
 * definition the compiler refused.
 *
 * What the compiler adds on top of DSL validation:
 *  - every node type must have an executor and every node config must satisfy
 *    that executor's own validation (so a bad config fails at compile time, not
 *    three nodes into a run);
 *  - node types the runtime cannot execute yet are refused with a reason
 *    (`NODE_NOT_EXECUTABLE`);
 *  - branch wiring is normalized into `branches` (handle → edges) so the engine
 *    never re-derives graph semantics;
 *  - execution statistics are computed for the builder's "estimated execution"
 *    preview.
 *
 * Determinism: node/edge order always follows declaration order, and the
 * adjacency maps are built by iterating `definition.nodes` / `definition.edges`.
 */

/** One outgoing edge of a compiled node. */
export interface CompiledEdge {
  id: string;
  source: string;
  target: string;
  /** Branch handle id; `""` is the single unnamed output. */
  handle: string;
  label: string | null;
}

export interface CompiledNode extends RuntimeNode {
  /** Declaration index — stable ordering for reproducible traversal. */
  order: number;
  description?: string;
  /** Outgoing edges grouped by branch handle, in declaration order. */
  branches: Record<string, CompiledEdge[]>;
  /** All outgoing edges, in declaration order (routers read this). */
  outgoing: CompiledEdge[];
  isTerminal: boolean;
}

export interface PlanStats {
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: Partial<Record<HarnessNodeType, number>>;
  /** Nodes that call a model: model, planner, critic, evaluator. */
  estimatedLlmCalls: number;
  estimatedToolCalls: number;
  loopCount: number;
  /** Highest configured loop budget in the graph. */
  maxIterations: number;
  conditionCount: number;
}

export interface CompileWarning {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ExecutionPlan {
  schemaVersion: number;
  /** SHA-256 of the canonical definition — ties every run to exact behavior. */
  contentHash: string;
  entryNode: string;
  exitNodes: string[];
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  /** nodeId → ordered target node ids (outgoing edges). */
  adjacency: Record<string, string[]>;
  /** nodeId → compiled node. */
  compiledNodes: Record<string, CompiledNode>;
  /** nodeId → ordered compiled outgoing edges (branch-aware). */
  edgesBySource: Record<string, CompiledEdge[]>;
  /** The single start node. */
  startNodeId: string;
  /** End nodes (terminal by validation). */
  terminalNodeIds: string[];
  stats: PlanStats;
  warnings: CompileWarning[];
}

export type CompileResult =
  | { ok: true; plan: ExecutionPlan; issues: [] }
  | { ok: false; plan: null; issues: HarnessValidationIssue[] };

/** Node types that spend an LLM call when executed. */
const LLM_NODE_TYPES: readonly HarnessNodeType[] = ["model", "planner", "critic", "evaluator"];

function computeStats(definition: HarnessDefinition): PlanStats {
  const nodeTypeCounts: Partial<Record<HarnessNodeType, number>> = {};
  let estimatedLlmCalls = 0;
  let estimatedToolCalls = 0;
  let loopCount = 0;
  let maxIterations = 0;
  let conditionCount = 0;

  for (const node of definition.nodes) {
    nodeTypeCounts[node.type] = (nodeTypeCounts[node.type] ?? 0) + 1;
    if (LLM_NODE_TYPES.includes(node.type)) {
      estimatedLlmCalls += 1;
    }
    if (node.type === "tool") {
      estimatedToolCalls += 1;
    }
    if (node.type === "loop") {
      loopCount += 1;
      const configured = (node.config as { maxIterations?: number }).maxIterations ?? 1;
      maxIterations = Math.max(maxIterations, configured);
    }
    if (node.type === "condition") {
      conditionCount += 1;
    }
  }

  return {
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    nodeTypeCounts,
    estimatedLlmCalls,
    estimatedToolCalls,
    loopCount,
    maxIterations,
    conditionCount,
  };
}

/**
 * Executor-level checks: known node type, executable node type, valid config,
 * and complete branch wiring for handled nodes.
 */
function executabilityIssues(
  definition: HarnessDefinition,
  edgesBySource: Map<string, HarnessEdge[]>,
): HarnessValidationIssue[] {
  const issues: HarnessValidationIssue[] = [];
  const registry = getNodeExecutorRegistry();

  for (const node of definition.nodes) {
    const unsupported = nodeUnsupportedReason(node.type, node.config as Record<string, unknown>);
    if (unsupported !== null) {
      issues.push({
        code: "NODE_NOT_EXECUTABLE",
        message: `Node "${node.label}" cannot run: ${unsupported}`,
        nodeId: node.id,
      });
      continue;
    }

    if (!registry.has(node.type)) {
      issues.push({
        code: "NODE_NOT_EXECUTABLE",
        message: `No runtime executor exists for node type "${node.type}"`,
        nodeId: node.id,
      });
      continue;
    }

    const runtimeNode: RuntimeNode = {
      id: node.id,
      type: node.type,
      label: node.label,
      ...(node.description !== undefined ? { description: node.description } : {}),
      config: node.config as Record<string, unknown>,
    };

    try {
      registry.validate(runtimeNode);
    } catch (error) {
      issues.push({
        code: "NODE_CONFIG_INVALID",
        message:
          error instanceof ValidationError
            ? error.message.replace(/^[^:]+:\s*/, "")
            : `Node "${node.label}" has invalid configuration`,
        nodeId: node.id,
      });
      continue;
    }

    // Tool nodes must reference a registered tool: discovering this at compile
    // time is strictly better than discovering it after spending tokens.
    if (node.type === "tool") {
      const toolId = (node.config as { toolId?: unknown }).toolId;
      if (typeof toolId === "string" && toolId !== "" && !getToolRegistry().has(toolId)) {
        const available = getToolRegistry()
          .list()
          .map((tool) => tool.id)
          .join(", ");
        issues.push({
          code: "NODE_CONFIG_INVALID",
          message: `Node "${node.label}" calls tool "${toolId}", which is not registered${
            available === "" ? "" : ` (available: ${available})`
          }`,
          nodeId: node.id,
        });
        continue;
      }
    }

    // Handled nodes must be able to leave through every declared branch.
    const declaredHandles = HANDLED_BRANCHES[node.type];
    if (declaredHandles !== undefined) {
      const present = new Set(
        (edgesBySource.get(node.id) ?? []).map((edge) => edge.sourceHandle ?? ""),
      );
      for (const handle of declaredHandles) {
        if (!present.has(handle)) {
          issues.push({
            code: "NODE_CONFIG_INVALID",
            message: `Node "${node.label}" has no "${handle}" branch — wire its outgoing edge`,
            nodeId: node.id,
          });
        }
      }
    }
  }

  return issues;
}

/** Node types whose branches are required to leave the node. */
const HANDLED_BRANCHES: Partial<Record<HarnessNodeType, string[]>> = {
  condition: ["true", "false"],
  loop: ["body", "exit"],
};

export function compileHarness(input: unknown): CompileResult {
  const validation = validateHarnessDefinition(input);
  if (!validation.ok) {
    return { ok: false, plan: null, issues: validation.issues };
  }

  const definition: HarnessDefinition = validation.definition;

  const edgesBySource = new Map<string, HarnessEdge[]>();
  for (const node of definition.nodes) {
    edgesBySource.set(node.id, []);
  }
  for (const edge of definition.edges) {
    edgesBySource.get(edge.source)?.push(edge);
  }

  const runtimeIssues = executabilityIssues(definition, edgesBySource);
  if (runtimeIssues.length > 0) {
    return { ok: false, plan: null, issues: runtimeIssues };
  }

  const adjacency: Record<string, string[]> = {};
  const edgesBySourceOut: Record<string, CompiledEdge[]> = {};
  const compiledNodes: Record<string, CompiledNode> = {};
  const warnings: CompileWarning[] = [];

  definition.nodes.forEach((node, order) => {
    adjacency[node.id] = [];
    const outgoing: CompiledEdge[] = [];
    const branches: Record<string, CompiledEdge[]> = {};

    for (const edge of edgesBySource.get(node.id) ?? []) {
      const handle = edge.sourceHandle ?? "";
      const compiledEdge: CompiledEdge = {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        handle,
        label: edge.label ?? null,
      };
      outgoing.push(compiledEdge);
      adjacency[node.id]?.push(edge.target);
      branches[handle] = [...(branches[handle] ?? []), compiledEdge];
    }

    if (outgoing.length > 1) {
      for (const [handle, edges] of Object.entries(branches)) {
        if (edges.length > 1) {
          warnings.push({
            code: "MULTIPLE_EDGES_PER_BRANCH",
            message: `Node "${node.label}" has ${edges.length} edges on branch ${
              handle === "" ? "(default)" : `"${handle}"`
            } — only the first is followed`,
            nodeId: node.id,
          });
        }
      }
    }

    compiledNodes[node.id] = {
      id: node.id,
      type: node.type,
      label: node.label,
      ...(node.description !== undefined ? { description: node.description } : {}),
      config: node.config as Record<string, unknown>,
      order,
      branches,
      outgoing,
      isTerminal: outgoing.length === 0,
    };
    edgesBySourceOut[node.id] = outgoing;
  });

  const startNode = definition.nodes.find((node) => node.id === definition.entryNode);
  if (startNode === undefined || startNode.type !== "start") {
    // Validation guarantees this, but the plan must not be constructible without it.
    return {
      ok: false,
      plan: null,
      issues: [
        {
          code: "ENTRY_NOT_START",
          message: "entryNode must reference the harness's start node",
          nodeId: definition.entryNode,
        },
      ],
    };
  }

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: definition.schemaVersion,
      contentHash: hashHarnessDefinition(definition),
      entryNode: definition.entryNode,
      exitNodes: [...definition.exitNodes],
      nodes: definition.nodes,
      edges: definition.edges,
      adjacency,
      compiledNodes,
      edgesBySource: edgesBySourceOut,
      startNodeId: startNode.id,
      terminalNodeIds: definition.nodes
        .filter((node) => node.type === "end")
        .map((node) => node.id),
      stats: computeStats(definition),
      warnings,
    },
  };
}

// --- execution preview ------------------------------------------------------

export interface PreviewCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ExecutionPreview {
  ok: boolean;
  checks: PreviewCheck[];
  issues: HarnessValidationIssue[];
  warnings: CompileWarning[];
  stats: PlanStats | null;
  /** Human-readable estimate line, e.g. "5 nodes · 2 LLM calls · 1 tool call". */
  estimate: string;
}

const CHECK_ISSUE_CODES: Array<{
  label: string;
  codes: HarnessValidationIssue["code"][];
  okDetail: string;
}> = [
  {
    label: "Graph is valid",
    codes: ["INVALID_SCHEMA", "DUPLICATE_NODE_ID", "DUPLICATE_EDGE_ID", "EDGE_UNKNOWN_SOURCE", "EDGE_UNKNOWN_TARGET", "EDGE_INVALID_HANDLE"],
    okDetail: "Structure and handles are consistent",
  },
  {
    label: "Start node found",
    codes: ["MISSING_START_NODE", "DUPLICATE_START_NODE", "MISSING_ENTRY_NODE", "ENTRY_NOT_START", "EDGE_INTO_START"],
    okDetail: "Exactly one entry point",
  },
  {
    label: "End node found",
    codes: ["MISSING_END_NODE", "MISSING_EXIT_NODE", "EXIT_NOT_END", "EXIT_NODE_MISMATCH", "DUPLICATE_EXIT_NODE"],
    okDetail: "At least one terminal node",
  },
  {
    label: "All nodes reachable",
    codes: ["UNREACHABLE_NODE", "NO_PATH_TO_END", "DEAD_END_NODE", "NON_TERMINAL_END_NODE"],
    okDetail: "Every node runs and can reach an end",
  },
  {
    label: "Branches wired",
    codes: ["CONDITION_MISSING_BRANCH", "UNDECLARED_CYCLE"],
    okDetail: "Conditions have true/false paths and loops are explicit",
  },
  {
    label: "Configuration executable",
    codes: ["NODE_CONFIG_INVALID", "NODE_NOT_EXECUTABLE"],
    okDetail: "Every node type has an executor and valid config",
  },
];

/**
 * Compiles and summarises a harness for the builder's Run dialog. Pure, no
 * side effects, no database: the same call renders the pre-run preview and
 * backs the "Run" button's enabled state.
 */
export function previewHarnessCompilation(input: unknown): ExecutionPreview {
  const result = compileHarness(input);

  if (!result.ok) {
    const codes = new Set(result.issues.map((issue) => issue.code));
    const checks = CHECK_ISSUE_CODES.map((check) => {
      const failing = check.codes.filter((code) => codes.has(code));
      return {
        label: check.label,
        ok: failing.length === 0,
        detail:
          failing.length === 0
            ? check.okDetail
            : (result.issues.find((issue) => failing.includes(issue.code))?.message ?? "Invalid"),
      };
    });
    return {
      ok: false,
      checks,
      issues: result.issues,
      warnings: [],
      stats: null,
      estimate: "Not executable yet",
    };
  }

  const stats = result.plan.stats;
  const parts = [`${stats.nodeCount} nodes`];
  if (stats.estimatedLlmCalls > 0) {
    parts.push(`${stats.estimatedLlmCalls} LLM ${stats.estimatedLlmCalls === 1 ? "call" : "calls"}`);
  }
  if (stats.estimatedToolCalls > 0) {
    parts.push(`${stats.estimatedToolCalls} tool ${stats.estimatedToolCalls === 1 ? "call" : "calls"}`);
  }
  if (stats.loopCount > 0) {
    parts.push(`up to ${stats.maxIterations} loop iterations`);
  }

  return {
    ok: true,
    checks: CHECK_ISSUE_CODES.map((check) => ({
      label: check.label,
      ok: true,
      detail: check.okDetail,
    })),
    issues: [],
    warnings: result.plan.warnings,
    stats,
    estimate: parts.join(" · "),
  };
}
