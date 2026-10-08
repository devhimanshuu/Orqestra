import {
  HARNESS_NODE_TYPES,
  NODE_CATEGORY_BY_TYPE,
  type HarnessNodeCategory,
  type HarnessNodeType,
} from "../harness.schema";

/**
 * Presentation + default-data metadata for every harness node type.
 *
 * This is the single source of truth for the node library, the canvas cards and
 * the inspector. It is framework-agnostic (no React Flow, no DOM) so the same
 * catalog can drive a future CLI or server-rendered summary.
 */

export type NodeCategoryMeta = {
  id: HarnessNodeCategory;
  label: string;
  hint: string;
};

export const NODE_CATEGORIES: NodeCategoryMeta[] = [
  { id: "control", label: "Control", hint: "Entry, exit and flow" },
  { id: "ai", label: "AI", hint: "Reasoning and synthesis" },
  { id: "tool", label: "Tools", hint: "External capabilities" },
  { id: "context", label: "Context", hint: "Prompt and memory assembly" },
  { id: "logic", label: "Logic", hint: "Branching and iteration" },
];

export type NodeTypeMeta = {
  type: HarnessNodeType;
  /** Library name, e.g. "Planner". */
  label: string;
  /** One-line description shown in the library and on the canvas card. */
  description: string;
  /** Longer help text shown in the inspector. */
  help: string;
  /** lucide-react icon name, mapped to a component in the canvas. */
  icon:
    | "Play"
    | "Square"
    | "Sparkles"
    | "MessageSquare"
    | "Wrench"
    | "Database"
    | "Layers"
    | "ListTree"
    | "Split"
    | "ShieldCheck"
    | "Gauge"
    | "GitBranch"
    | "Repeat"
    | "UserCheck"
    | "Shuffle";
  category: HarnessNodeCategory;
  /** Accent used for the node card, minimap and library swatch. */
  accent: string;
  /** Data applied when the node is created from the library. */
  defaultLabel: string;
  defaultDescription: string;
  defaultConfig: Record<string, unknown>;
};

export const NODE_CATALOG: Record<HarnessNodeType, NodeTypeMeta> = {
  start: {
    type: "start",
    label: "Start",
    description: "Entry point of the harness",
    help: "Every harness has exactly one start node. Execution begins here.",
    icon: "Play",
    category: "control",
    accent: "#10b981",
    defaultLabel: "Start",
    defaultDescription: "Harness entry point",
    defaultConfig: {},
  },
  end: {
    type: "end",
    label: "End",
    description: "Terminates the run and returns output",
    help: "A harness needs at least one end node. Unreached branches are reported as validation warnings.",
    icon: "Square",
    category: "control",
    accent: "#ef4444",
    defaultLabel: "End",
    defaultDescription: "Terminal node",
    defaultConfig: {},
  },
  model: {
    type: "model",
    label: "Model",
    description: "Calls an LLM with a prompt",
    help: "Resolves a model through the LLM gateway. Use provider:model, e.g. gemini:gemini-2.0-flash.",
    icon: "Sparkles",
    category: "ai",
    accent: "#8b5cf6",
    defaultLabel: "Model Call",
    defaultDescription: "Single LLM call",
    defaultConfig: { model: "gemini:gemini-2.0-flash", temperature: 0.2 },
  },
  prompt: {
    type: "prompt",
    label: "Prompt",
    description: "Builds a prompt template",
    help: "Template text with {{state.path}} placeholders resolved at runtime.",
    icon: "MessageSquare",
    category: "ai",
    accent: "#6366f1",
    defaultLabel: "Prompt",
    defaultDescription: "Template rendering",
    defaultConfig: { template: "{{run.input}}" },
  },
  planner: {
    type: "planner",
    label: "Planner",
    description: "Breaks the task into steps",
    help: "Produces an ordered plan that downstream nodes can consume from run state.",
    icon: "ListTree",
    category: "ai",
    accent: "#a855f7",
    defaultLabel: "Planner",
    defaultDescription: "Decompose the task",
    defaultConfig: {
      instructions: "Break the task into the smallest useful sequence of steps.",
      maxSteps: 8,
    },
  },
  critic: {
    type: "critic",
    label: "Critic",
    description: "Reviews intermediate output",
    help: "Scores the current output and reports issues before verification.",
    icon: "ShieldCheck",
    category: "ai",
    accent: "#f59e0b",
    defaultLabel: "Critic",
    defaultDescription: "Review the draft",
    defaultConfig: {
      instructions: "Identify unsupported claims and missing evidence.",
      threshold: 0.7,
    },
  },
  evaluator: {
    type: "evaluator",
    label: "Evaluator",
    description: "Scores output against a metric",
    help: "Writes a numeric score into run state for conditions and experiments.",
    icon: "Gauge",
    category: "ai",
    accent: "#14b8a6",
    defaultLabel: "Evaluator",
    defaultDescription: "Score the output",
    defaultConfig: { instructions: "Score the answer for factual grounding.", metric: "groundedness" },
  },
  tool: {
    type: "tool",
    label: "Tool",
    description: "Invokes a registered tool",
    help: "Tools are resolved from the tool registry by id; inputs are validated against the tool schema.",
    icon: "Wrench",
    category: "tool",
    accent: "#0ea5e9",
    defaultLabel: "Tool Call",
    defaultDescription: "Run a tool",
    defaultConfig: { toolId: "calculator" },
  },
  memory: {
    type: "memory",
    label: "Memory",
    description: "Reads or writes run memory",
    help: "Scope controls how long memory survives: step, run, session or persistent.",
    icon: "Database",
    category: "context",
    accent: "#22c55e",
    defaultLabel: "Memory",
    defaultDescription: "Scoped memory access",
    defaultConfig: { scope: "run", maxItems: 20 },
  },
  context: {
    type: "context",
    label: "Context",
    description: "Assembles context for the prompt",
    help: "Pulls agent instructions, run input, accumulated state or a static value.",
    icon: "Layers",
    category: "context",
    accent: "#3b82f6",
    defaultLabel: "Context Builder",
    defaultDescription: "Assemble context",
    defaultConfig: { source: "agent_instructions" },
  },
  condition: {
    type: "condition",
    label: "Condition",
    description: "Boolean branch on run state",
    help: "True and false paths are separate outgoing handles. Example: state.score >= 0.8",
    icon: "GitBranch",
    category: "logic",
    accent: "#eab308",
    defaultLabel: "Condition",
    defaultDescription: "Branch on state",
    defaultConfig: { expression: "state.score >= 0.8" },
  },
  router: {
    type: "router",
    label: "Router",
    description: "Chooses a downstream path",
    help: "Selects one of several outgoing paths based on instructions and state.",
    icon: "Split",
    category: "logic",
    accent: "#f97316",
    defaultLabel: "Router",
    defaultDescription: "Route to a path",
    defaultConfig: { instructions: "Route to the path that best fits the request." },
  },
  loop: {
    type: "loop",
    label: "Loop",
    description: "Repeats a section of the graph",
    help: "Cycles in a harness are only legal when a loop node sits on the cycle.",
    icon: "Repeat",
    category: "logic",
    accent: "#ec4899",
    defaultLabel: "Loop",
    defaultDescription: "Iterate the section",
    defaultConfig: { maxIterations: 3 },
  },
  human_approval: {
    type: "human_approval",
    label: "Human Approval",
    description: "Pauses for a human decision",
    help: "Suspends the run until an operator approves or rejects it.",
    icon: "UserCheck",
    category: "logic",
    accent: "#64748b",
    defaultLabel: "Human Approval",
    defaultDescription: "Await a decision",
    defaultConfig: { instructions: "Approve the drafted answer before it is returned." },
  },
  transform: {
    type: "transform",
    label: "Transform",
    description: "Maps state from input to output",
    help: "Expression applied to run state before the next node executes.",
    icon: "Shuffle",
    category: "logic",
    accent: "#84cc16",
    defaultLabel: "Transform",
    defaultDescription: "Reshape state",
    defaultConfig: { expression: "{ output: state.draft }" },
  },
};

export function getNodeTypeMeta(type: HarnessNodeType): NodeTypeMeta {
  return NODE_CATALOG[type];
}

export const NODE_TYPES_BY_CATEGORY: Array<{ category: NodeCategoryMeta; nodeTypes: NodeTypeMeta[] }> =
  NODE_CATEGORIES.map((category) => ({
    category,
    nodeTypes: HARNESS_NODE_TYPES.filter(
      (type) => NODE_CATEGORY_BY_TYPE[type] === category.id,
    ).map((type) => NODE_CATALOG[type]),
  }));

/** Node types that may only appear once per harness. */
export const SINGLETON_NODE_TYPES: HarnessNodeType[] = ["start"];
