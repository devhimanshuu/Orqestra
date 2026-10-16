import { z } from "zod";
import { NODE_CONFIG_SCHEMAS, type HarnessNodeType } from "@/modules/harness/harness.schema";
import { INSERTABLE_NODE_TYPES, type MutationRisk } from "../optimization.types";

/**
 * The mutation vocabulary.
 *
 * Every change the optimizer may make is one of these five typed operations.
 * The set is deliberately small, and each operation carries an explicit policy:
 *
 *  - **Prompt changes** touch only *text* fields that already exist on a node
 *    (`template`, `systemPrompt`, `instructions`) — never tool ids, never model
 *    providers, never credentials.
 *  - **Config changes** are restricted to an allowlist of *numeric behaviour
 *    knobs* with platform ceilings. A mutation can lower a loop bound or raise
 *    it a little inside the ceiling; it cannot touch a tool's permissions, a
 *    provider model, or any secret.
 *  - **Graph changes** may only insert behaviour-only node types, may never
 *    remove start/end/approval/tool nodes, and refuse anything that would leave
 *    the graph ambiguous.
 *
 * An operation that fails any of these rules is *rejected with a reason* and
 * recorded — never silently dropped.
 */

/** Loop-iteration ceiling a mutation may raise a loop to (runtime ceiling is higher). */
export const MAX_MUTABLE_LOOP_ITERATIONS = 25;

/** Text fields a prompt mutation may write, per node type. */
export const PROMPT_FIELDS: Record<string, readonly string[]> = {
  model: ["systemPrompt"],
  prompt: ["template"],
  planner: ["instructions"],
  router: ["instructions"],
  critic: ["instructions"],
  evaluator: ["instructions"],
  human_approval: ["instructions"],
};

/**
 * Numeric fields a config mutation may write, per node type, with the range the
 * runtime itself accepts. Anything not listed here is unreachable by the engine.
 */
export const MUTABLE_NUMERIC_FIELDS: Record<
  string,
  Array<{ key: string; min: number; max: number; integer: boolean }>
> = {
  loop: [
    { key: "maxIterations", min: 1, max: MAX_MUTABLE_LOOP_ITERATIONS, integer: true },
  ],
  planner: [{ key: "maxSteps", min: 1, max: 50, integer: true }],
  model: [
    { key: "temperature", min: 0, max: 2, integer: false },
    { key: "maxTokens", min: 1, max: 32_768, integer: true },
  ],
  critic: [{ key: "threshold", min: 0, max: 1, integer: false }],
  memory: [{ key: "maxItems", min: 1, max: 1_000, integer: true }],
  context: [{ key: "maxTokens", min: 1, max: 200_000, integer: true }],
  human_approval: [{ key: "timeoutMs", min: 1_000, max: 3_600_000, integer: true }],
};

const reasonSchema = z.string().trim().min(1).max(1_000);

const base = {
  reason: reasonSchema,
};

export const setPromptInstructionSchema = z.strictObject({
  ...base,
  op: z.literal("set_prompt_instruction"),
  nodeId: z.string().min(1).max(64),
  /** Which textual field of the node to write. */
  field: z.enum(["template", "systemPrompt", "instructions"]),
  mode: z.enum(["append", "prepend", "replace"]).default("append"),
  value: z.string().trim().min(1).max(2_000),
});

export const setNodeConfigSchema = z.strictObject({
  ...base,
  op: z.literal("set_node_config"),
  nodeId: z.string().min(1).max(64),
  key: z.string().trim().min(1).max(40),
  value: z.number(),
});

export const insertNodeSchema = z.strictObject({
  ...base,
  op: z.literal("insert_node"),
  /** Id for the new node. Must not already exist. */
  nodeId: z.string().trim().min(1).max(64),
  nodeType: z.enum(INSERTABLE_NODE_TYPES),
  label: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
  /** The existing edge to split: source → (new node) → target. */
  edgeId: z.string().min(1).max(64),
});

export const removeNodeSchema = z.strictObject({
  ...base,
  op: z.literal("remove_node"),
  nodeId: z.string().min(1).max(64),
});

export const reconnectEdgeSchema = z.strictObject({
  ...base,
  op: z.literal("reconnect_edge"),
  edgeId: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
});

export const mutationOperationSchema = z.discriminatedUnion("op", [
  setPromptInstructionSchema,
  setNodeConfigSchema,
  insertNodeSchema,
  removeNodeSchema,
  reconnectEdgeSchema,
]);

export type MutationOperation = z.infer<typeof mutationOperationSchema>;
export type SetPromptInstruction = z.infer<typeof setPromptInstructionSchema>;
export type SetNodeConfig = z.infer<typeof setNodeConfigSchema>;
export type InsertNode = z.infer<typeof insertNodeSchema>;
export type RemoveNode = z.infer<typeof removeNodeSchema>;
export type ReconnectEdge = z.infer<typeof reconnectEdgeSchema>;

/** Operation names, for the change-set UI and the audit trail. */
export const MUTATION_OPERATIONS = [
  "set_prompt_instruction",
  "set_node_config",
  "insert_node",
  "remove_node",
  "reconnect_edge",
] as const;
export type MutationOperationName = (typeof MUTATION_OPERATIONS)[number];

/** Parses an untrusted value (including model output) into typed operations. */
export function parseMutationOperations(
  value: unknown,
): { ok: true; operations: MutationOperation[] } | { ok: false; issues: string[] } {
  const parsed = z.array(mutationOperationSchema).max(20).safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, operations: parsed.data };
}

/** The field a prompt mutation writes, when the node type exposes it. */
export function promptFieldAllowed(nodeType: string, field: string): boolean {
  return (PROMPT_FIELDS[nodeType] ?? []).includes(field);
}

/** The numeric knob a config mutation writes, when the policy allows it. */
export function numericFieldPolicy(
  nodeType: string,
  key: string,
): { min: number; max: number; integer: boolean } | null {
  const allowed = MUTABLE_NUMERIC_FIELDS[nodeType] ?? [];
  return allowed.find((entry) => entry.key === key) ?? null;
}

/** The config schema a node type validates against (used to gate insertions). */
export function configSchemaFor(nodeType: string) {
  return (NODE_CONFIG_SCHEMAS as Record<string, z.ZodType>)[nodeType] ?? null;
}

export function isInsertableNodeType(value: string): value is HarnessNodeType {
  return (INSERTABLE_NODE_TYPES as readonly string[]).includes(value);
}

/**
 * Risk classification. Structural graph edits and any change that *raises* a
 * behaviour bound are MEDIUM; tightening a bound or the wording of instructions
 * is LOW. HIGH is reserved for changes the engine refuses outright (it never
 * produces one), so a HIGH in stored data always means a human wrote it.
 */
export function assessRisk(
  operation: MutationOperation,
  context: { before?: unknown; nodeType?: string } = {},
): MutationRisk {
  switch (operation.op) {
    case "set_prompt_instruction":
      return operation.mode === "replace" ? "MEDIUM" : "LOW";
    case "set_node_config": {
      const before = typeof context.before === "number" ? context.before : null;
      if (before !== null && operation.value > before) {
        return "MEDIUM";
      }
      return "LOW";
    }
    case "insert_node":
      return "MEDIUM";
    case "remove_node":
      return "MEDIUM";
    case "reconnect_edge":
      return "MEDIUM";
    default:
      return "MEDIUM";
  }
}
