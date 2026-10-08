import { z } from "zod";

/**
 * Harness DSL — schema source of truth (v2).
 *
 * Everything else (TS types, validation, serialization, persistence, the
 * React Flow adapter) derives from these Zod schemas, so the type system,
 * runtime validation, and stored JSON can never drift apart.
 *
 * Versioning strategy: `schemaVersion` identifies the DSL dialect of a stored
 * definition. v1 (Phase 0) had no explicit start/end nodes; definitions in the
 * old dialect are upgraded in memory by `upgradeHarnessDefinition()` before
 * validation, so stored rows stay readable forever (versions are immutable).
 *
 * To add a node type: add a strict config schema to the union below, add its
 * handle convention to NODE_HANDLE_SPEC, extend the node catalog in
 * `editor/node-catalog.ts`, and cover it with tests.
 */

export const HARNESS_SCHEMA_VERSION = 2 as const;

export const HARNESS_NODE_TYPES = [
  // control
  "start",
  "end",
  // ai
  "model",
  "prompt",
  "planner",
  "critic",
  "evaluator",
  // tool
  "tool",
  // context
  "memory",
  "context",
  // logic
  "condition",
  "router",
  "loop",
  // lifecycle
  "human_approval",
  "transform",
] as const;

export type HarnessNodeType = (typeof HARNESS_NODE_TYPES)[number];

export type HarnessNodeCategory = "control" | "ai" | "tool" | "context" | "logic";

export const NODE_CATEGORY_BY_TYPE: Record<HarnessNodeType, HarnessNodeCategory> = {
  start: "control",
  end: "control",
  model: "ai",
  prompt: "ai",
  planner: "ai",
  critic: "ai",
  evaluator: "ai",
  tool: "tool",
  memory: "context",
  context: "context",
  condition: "logic",
  router: "logic",
  loop: "logic",
  human_approval: "logic",
  transform: "logic",
};

/**
 * Handle conventions: which connectors a node type exposes, and the ids of its
 * outgoing branches. The UI derives its handles from this, and validation
 * rejects edges that do not fit the spec (e.g. a `condition` edge without a
 * `true`/`false` branch, or an edge into a `start` node).
 */
export interface NodeHandleSpec {
  input: boolean;
  /** Empty array = terminal node. A single empty string = one unnamed output. */
  outputs: string[];
}

export const NODE_HANDLE_SPEC: Record<HarnessNodeType, NodeHandleSpec> = {
  start: { input: false, outputs: [""] },
  end: { input: true, outputs: [] },
  model: { input: true, outputs: [""] },
  prompt: { input: true, outputs: [""] },
  planner: { input: true, outputs: [""] },
  critic: { input: true, outputs: [""] },
  evaluator: { input: true, outputs: [""] },
  tool: { input: true, outputs: [""] },
  memory: { input: true, outputs: [""] },
  context: { input: true, outputs: [""] },
  condition: { input: true, outputs: ["true", "false"] },
  router: { input: true, outputs: [""] },
  loop: { input: true, outputs: ["body", "exit"] },
  human_approval: { input: true, outputs: [""] },
  transform: { input: true, outputs: [""] },
};

export function getHandleSpec(type: HarnessNodeType): NodeHandleSpec {
  return NODE_HANDLE_SPEC[type];
}

const positionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

const nodeBase = {
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  /** Editor layout. Kept in the DSL so an exported harness reopens identically. */
  position: positionSchema.default({ x: 0, y: 0 }),
  description: z.string().max(500).optional(),
};

/**
 * Per-node-type configuration. Configs are strict objects: unknown keys are
 * rejected so typos fail validation loudly instead of silently doing nothing.
 */

const startNode = z.strictObject({
  ...nodeBase,
  type: z.literal("start"),
  config: z.strictObject({}),
});

const endNode = z.strictObject({
  ...nodeBase,
  type: z.literal("end"),
  config: z.strictObject({}),
});

const modelNode = z.strictObject({
  ...nodeBase,
  type: z.literal("model"),
  config: z.strictObject({
    /** "provider:model" — resolved by the LLM gateway, never hard-coded. */
    model: z.string().min(1),
    provider: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),
  }),
});

const promptNode = z.strictObject({
  ...nodeBase,
  type: z.literal("prompt"),
  config: z.strictObject({
    template: z.string().min(1),
  }),
});

const toolNode = z.strictObject({
  ...nodeBase,
  type: z.literal("tool"),
  config: z.strictObject({
    toolId: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
});

const memoryNode = z.strictObject({
  ...nodeBase,
  type: z.literal("memory"),
  config: z.strictObject({
    scope: z.enum(["step", "run", "session", "persistent"]),
    maxItems: z.number().int().positive().optional(),
  }),
});

const contextNode = z.strictObject({
  ...nodeBase,
  type: z.literal("context"),
  config: z.strictObject({
    source: z.enum(["agent_instructions", "run_input", "state", "static"]),
    /** Required when source is "static" (validated in graph rules). */
    value: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
});

const plannerNode = z.strictObject({
  ...nodeBase,
  type: z.literal("planner"),
  config: z.strictObject({
    instructions: z.string().min(1),
    maxSteps: z.number().int().positive().max(50).optional(),
  }),
});

const routerNode = z.strictObject({
  ...nodeBase,
  type: z.literal("router"),
  config: z.strictObject({
    instructions: z.string().min(1),
  }),
});

const criticNode = z.strictObject({
  ...nodeBase,
  type: z.literal("critic"),
  config: z.strictObject({
    instructions: z.string().min(1),
    threshold: z.number().min(0).max(1).optional(),
  }),
});

const evaluatorNode = z.strictObject({
  ...nodeBase,
  type: z.literal("evaluator"),
  config: z.strictObject({
    instructions: z.string().min(1),
    metric: z.string().min(1),
  }),
});

const conditionNode = z.strictObject({
  ...nodeBase,
  type: z.literal("condition"),
  config: z.strictObject({
    /** Boolean expression over run state, e.g. "state.score >= 0.8". */
    expression: z.string().min(1),
  }),
});

const loopNode = z.strictObject({
  ...nodeBase,
  type: z.literal("loop"),
  config: z.strictObject({
    maxIterations: z.number().int().min(1).max(100),
  }),
});

const humanApprovalNode = z.strictObject({
  ...nodeBase,
  type: z.literal("human_approval"),
  config: z.strictObject({
    instructions: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
});

const transformNode = z.strictObject({
  ...nodeBase,
  type: z.literal("transform"),
  config: z.strictObject({
    /** Expression mapping incoming state to outgoing state. */
    expression: z.string().min(1),
  }),
});

export const harnessNodeSchema = z.discriminatedUnion("type", [
  startNode,
  endNode,
  modelNode,
  promptNode,
  toolNode,
  memoryNode,
  contextNode,
  plannerNode,
  routerNode,
  criticNode,
  evaluatorNode,
  conditionNode,
  loopNode,
  humanApprovalNode,
  transformNode,
]);

/**
 * Config schema per node type. The editor inspector uses these to validate a
 * single node's configuration in isolation (field-level errors), while the
 * discriminated union above stays the authority for whole documents.
 */
export const NODE_CONFIG_SCHEMAS = {
  start: startNode.shape.config,
  end: endNode.shape.config,
  model: modelNode.shape.config,
  prompt: promptNode.shape.config,
  tool: toolNode.shape.config,
  memory: memoryNode.shape.config,
  context: contextNode.shape.config,
  planner: plannerNode.shape.config,
  router: routerNode.shape.config,
  critic: criticNode.shape.config,
  evaluator: evaluatorNode.shape.config,
  condition: conditionNode.shape.config,
  loop: loopNode.shape.config,
  human_approval: humanApprovalNode.shape.config,
  transform: transformNode.shape.config,
} satisfies Record<HarnessNodeType, z.ZodType>;

export const harnessEdgeSchema = z.strictObject({
  id: z.string().min(1).max(64),
  source: z.string().min(1),
  target: z.string().min(1),
  /** Required when the source node exposes named branches (condition, loop). */
  sourceHandle: z.string().min(1).optional(),
  targetHandle: z.string().min(1).optional(),
  label: z.string().max(120).optional(),
});

export const harnessDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(HARNESS_SCHEMA_VERSION).default(HARNESS_SCHEMA_VERSION),
  /** Stable identifier of the harness (its slug, unique per project). */
  id: z.string().min(1),
  /** Version number within the harness (assigned by the service on publish). */
  version: z.number().int().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  nodes: z.array(harnessNodeSchema).min(1),
  edges: z.array(harnessEdgeSchema),
  /** Must be the id of the single `start` node. */
  entryNode: z.string().min(1),
  /** Must be ids of `end` nodes. */
  exitNodes: z.array(z.string().min(1)).min(1),
});

/**
 * Draft document — what the builder autosaves.
 *
 * Deliberately looser than a full definition: a draft may be missing nodes,
 * start/end wiring, or an entry point while the user is still editing, and a
 * node's config may be half-filled (an emptied required field must not block
 * autosave). Node *identity* and *geometry* stay strict, so a draft can never
 * contain invented node types or malformed positions; configs are validated
 * when the user validates or publishes.
 */
export const harnessDraftNodeSchema = z.strictObject({
  ...nodeBase,
  type: z.enum(HARNESS_NODE_TYPES),
  /** Loose while editing — `harnessNodeSchema` is the authority at publish time. */
  config: z.record(z.string(), z.unknown()),
});

export type HarnessDraftNode = z.infer<typeof harnessDraftNodeSchema>;

export const harnessDraftDocumentSchema = z.strictObject({
  schemaVersion: z.literal(HARNESS_SCHEMA_VERSION).default(HARNESS_SCHEMA_VERSION),
  id: z.string().min(1).max(64).optional(),
  version: z.number().int().min(1).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  nodes: z.array(harnessDraftNodeSchema).max(300),
  edges: z.array(harnessEdgeSchema).max(600),
  entryNode: z.string().min(1).optional(),
  exitNodes: z.array(z.string().min(1)).max(20).optional(),
});

export type HarnessDraftDocument = z.infer<typeof harnessDraftDocumentSchema>;

export type HarnessNode = z.infer<typeof harnessNodeSchema>;
export type HarnessEdge = z.infer<typeof harnessEdgeSchema>;
export type HarnessDefinition = z.infer<typeof harnessDefinitionSchema>;
export type HarnessNodeOf<T extends HarnessNodeType> = Extract<HarnessNode, { type: T }>;
