import type { HarnessNodeType } from "../harness.schema";

/**
 * Inspector field metadata per node type.
 *
 * The inspector renders from this table instead of hand-written forms, so a new
 * node type only needs a schema (the authority) plus a list of fields (the UI).
 * Field keys must match the node config schema — validation reports the mismatch.
 */

export type FieldKind = "text" | "textarea" | "number" | "select" | "boolean";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  /** Half-width in the inspector grid; defaults to full width. */
  half?: boolean;
  /** Field is only rendered while this predicate holds (e.g. static context value). */
  visibleWhen?: (config: Record<string, unknown>) => boolean;
}

const MODEL_OPTIONS = [
  { value: "gemini:gemini-2.0-flash", label: "gemini:gemini-2.0-flash" },
  { value: "gemini:gemini-2.5-pro", label: "gemini:gemini-2.5-pro" },
  { value: "ollama:llama3.1", label: "ollama:llama3.1" },
  { value: "groq:llama-3.3-70b-versatile", label: "groq:llama-3.3-70b-versatile" },
  { value: "openai:gpt-4o-mini", label: "openai:gpt-4o-mini" },
  { value: "anthropic:claude-sonnet-4", label: "anthropic:claude-sonnet-4" },
];

const PROVIDER_OPTIONS = [
  { value: "gemini", label: "Gemini" },
  { value: "ollama", label: "Ollama" },
  { value: "groq", label: "Groq" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "huggingface", label: "Hugging Face" },
];

export const NODE_FIELD_SPECS: Record<HarnessNodeType, FieldSpec[]> = {
  start: [],
  end: [],
  model: [
    {
      key: "model",
      label: "Model",
      kind: "text",
      placeholder: "provider:model",
      help: "Resolved by the LLM gateway, e.g. gemini:gemini-2.0-flash",
    },
    { key: "provider", label: "Provider", kind: "select", options: PROVIDER_OPTIONS, half: true },
    { key: "temperature", label: "Temperature", kind: "number", min: 0, max: 2, step: 0.1, half: true },
    { key: "maxTokens", label: "Max tokens", kind: "number", min: 1, step: 64, half: true },
    {
      key: "systemPrompt",
      label: "System instructions",
      kind: "textarea",
      rows: 4,
      placeholder: "You are a rigorous research assistant…",
    },
  ],
  prompt: [
    {
      key: "template",
      label: "Template",
      kind: "textarea",
      rows: 6,
      placeholder: "Summarise {{state.target}} using the evidence below…",
      help: "Supports {{run.input}} and {{state.*}} placeholders.",
    },
  ],
  planner: [
    {
      key: "instructions",
      label: "Instructions",
      kind: "textarea",
      rows: 5,
      help: "How the planner should decompose the task.",
    },
    { key: "maxSteps", label: "Max steps", kind: "number", min: 1, max: 50, half: true },
  ],
  critic: [
    { key: "instructions", label: "Instructions", kind: "textarea", rows: 5 },
    { key: "threshold", label: "Pass threshold", kind: "number", min: 0, max: 1, step: 0.05, half: true },
  ],
  evaluator: [
    { key: "instructions", label: "Instructions", kind: "textarea", rows: 4 },
    { key: "metric", label: "Metric", kind: "text", placeholder: "groundedness", half: true },
  ],
  tool: [
    {
      key: "toolId",
      label: "Tool",
      kind: "text",
      placeholder: "calculator",
      help: "Tool id from the registry; inputs are validated against the tool schema.",
    },
  ],
  memory: [
    {
      key: "scope",
      label: "Scope",
      kind: "select",
      options: [
        { value: "step", label: "Step" },
        { value: "run", label: "Run" },
        { value: "session", label: "Session" },
        { value: "persistent", label: "Persistent" },
      ],
      half: true,
    },
    { key: "maxItems", label: "Max items", kind: "number", min: 1, half: true },
  ],
  context: [
    {
      key: "source",
      label: "Source",
      kind: "select",
      options: [
        { value: "agent_instructions", label: "Agent instructions" },
        { value: "run_input", label: "Run input" },
        { value: "state", label: "Accumulated state" },
        { value: "static", label: "Static value" },
      ],
    },
    {
      key: "value",
      label: "Static value",
      kind: "textarea",
      rows: 3,
      visibleWhen: (config) => config.source === "static",
      help: "Required when the source is a static value.",
    },
    { key: "maxTokens", label: "Max tokens", kind: "number", min: 1, half: true },
  ],
  condition: [
    {
      key: "expression",
      label: "Expression",
      kind: "text",
      placeholder: "state.score >= 0.8",
      help: "Evaluated against run state; true and false branches are wired separately.",
    },
  ],
  router: [
    {
      key: "instructions",
      label: "Routing instructions",
      kind: "textarea",
      rows: 5,
      help: "How to pick among the outgoing paths.",
    },
  ],
  loop: [
    { key: "maxIterations", label: "Max iterations", kind: "number", min: 1, max: 100, half: true },
  ],
  human_approval: [
    { key: "instructions", label: "Approval instructions", kind: "textarea", rows: 4 },
    { key: "timeoutMs", label: "Timeout (ms)", kind: "number", min: 1, half: true },
  ],
  transform: [
    {
      key: "expression",
      label: "Expression",
      kind: "textarea",
      rows: 4,
      placeholder: "{ output: state.draft }",
      help: "Maps incoming state to outgoing state.",
    },
  ],
};

export function getFieldSpecs(type: HarnessNodeType): FieldSpec[] {
  return NODE_FIELD_SPECS[type];
}

export { MODEL_OPTIONS };
