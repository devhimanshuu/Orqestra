/**
 * Hypothesis generation (Strategy 1 — rule-based).
 *
 * Turns findings into *testable* claims with a specific, minimal change
 * attached. The rules encode two product judgements:
 *
 *  - **The smallest change wins.** A wording fix on the node that shapes the
 *    output is preferred over adding a node; graph edits are offered as an
 *    *alternative*, never as the default, because a new node costs latency and
 *    tokens on every case.
 *  - **Every change names a real target.** Rules resolve node ids from the
 *    baseline definition; a hypothesis whose target does not exist is not
 *    proposed at all (rather than proposing something unrunnable).
 *
 * These are hypotheses, not conclusions: each one states what it expects, what
 * it risks, and which metric would show it worked.
 */

import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import { NODE_CONFIG_SCHEMAS } from "@/modules/harness/harness.schema";
import type {
  FailureCategory,
  FailureFindingRecord,
  FindingConfidence,
  OptimizationObjective,
  ProposedHypothesis,
} from "../optimization.types";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";

export interface HypothesisGenerationInput {
  findings: readonly FailureFindingRecord[];
  /** The baseline definition every operation targets. */
  definition: HarnessDefinition | null;
  objective: OptimizationObjective;
  evaluatorConfig: readonly EvaluatorAssignmentSnapshot[];
  /** The session's strategy (rule-based rules also run for LLM sessions as a fallback). */
  origin?: "RULE_BASED" | "LLM_ASSISTED" | "MANUAL";
  /** Require review for graph edits regardless of session settings. */
  gateGraphEdits?: boolean;
}

interface Edge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface NodeLike {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
}

/** Nodes in execution order can't be derived cheaply; use graph adjacency. */
function predecessors(definition: HarnessDefinition, nodeId: string): NodeLike[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node as unknown as NodeLike]));
  return definition.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => byId.get(edge.source))
    .filter((node): node is NodeLike => node !== undefined);
}

/** The textual field a node writes its instructions into, when it has one. */
function textFieldFor(node: NodeLike): "systemPrompt" | "template" | "instructions" | null {
  if (node.type === "model") {
    return "systemPrompt";
  }
  if (node.type === "prompt") {
    return "template";
  }
  if (["planner", "router", "critic", "evaluator", "human_approval"].includes(node.type)) {
    return "instructions";
  }
  return null;
}

/**
 * The node whose text shapes the final answer: the predecessor of the first exit
 * node that can hold instructions, falling back to the model node in the graph.
 */
function outputNode(definition: HarnessDefinition): NodeLike | null {
  for (const exitNode of definition.exitNodes) {
    for (const candidate of predecessors(definition, exitNode)) {
      if (textFieldFor(candidate) !== null) {
        return candidate;
      }
    }
  }
  return definition.nodes
    .map((node) => node as unknown as NodeLike)
    .find((node) => textFieldFor(node) !== null) ?? null;
}

/** The node that decides which tool runs: the nearest textual predecessor of a tool node. */
function toolSelectingNode(definition: HarnessDefinition): NodeLike | null {
  for (const toolNode of definition.nodes.filter((node) => node.type === "tool")) {
    const chain = predecessors(definition, toolNode.id);
    const textual = chain.find((node) => textFieldFor(node) !== null);
    if (textual !== undefined) {
      return textual;
    }
  }
  // A tool-less harness can still reason about tool use in its planner/router.
  return definition.nodes
    .map((node) => node as unknown as NodeLike)
    .find((node) => node.type === "planner" || node.type === "router") ?? null;
}

function loopNodes(definition: HarnessDefinition): NodeLike[] {
  return definition.nodes
    .map((node) => node as unknown as NodeLike)
    .filter((node) => node.type === "loop");
}

function modelNodes(definition: HarnessDefinition): NodeLike[] {
  return definition.nodes
    .map((node) => node as unknown as NodeLike)
    .filter((node) => node.type === "model");
}

function firstExitNode(definition: HarnessDefinition): string | null {
  return definition.exitNodes[0] ?? null;
}

/** The edge that runs into an exit node (the split point for an inserted critic). */
function edgeIntoExit(definition: HarnessDefinition): Edge | null {
  const exit = firstExitNode(definition);
  if (exit === null) {
    return null;
  }
  const edge = definition.edges.find((entry) => entry.target === exit);
  return edge === undefined ? null : (edge as Edge);
}

/** Required tool ids, read from the pinned tool_usage evaluator configuration. */
function requiredTools(config: readonly EvaluatorAssignmentSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const assignment of config) {
    if (assignment.kind !== "tool_usage") {
      continue;
    }
    const required = (assignment.config as { required?: unknown }).required;
    if (Array.isArray(required)) {
      for (const entry of required) {
        if (typeof entry === "string" && entry.length > 0) {
          ids.add(entry);
        }
      }
    }
  }
  return [...ids];
}

function appendInstruction(
  node: NodeLike,
  field: "systemPrompt" | "template" | "instructions",
  value: string,
  reason: string,
): unknown {
  return {
    op: "set_prompt_instruction",
    nodeId: node.id,
    field,
    mode: "append",
    value,
    reason,
  };
}

function insertCritic(
  definition: HarnessDefinition,
  instructions: string,
  reason: string,
  existingIds: readonly string[],
): { op: unknown; nodeId: string } | null {
  const edge = edgeIntoExit(definition);
  if (edge === null) {
    return null;
  }
  let index = 1;
  let nodeId = `critic-${index}`;
  const taken = new Set([...definition.nodes.map((node) => node.id), ...existingIds]);
  while (taken.has(nodeId)) {
    index += 1;
    nodeId = `critic-${index}`;
  }
  return {
    nodeId,
    op: {
      op: "insert_node",
      nodeId,
      nodeType: "critic",
      label: "Verify before answering",
      config: { instructions },
      edgeId: edge.id,
      reason,
    },
  };
}

function numericKnob(
  node: NodeLike,
  key: string,
  value: number,
  reason: string,
): unknown | null {
  const schema = (NODE_CONFIG_SCHEMAS as Record<string, import("zod").ZodType>)[node.type];
  if (schema === undefined) {
    return null;
  }
  const merged = { ...node.config, [key]: value };
  if (!schema.safeParse(merged).success) {
    return null;
  }
  return { op: "set_node_config", nodeId: node.id, key, value, reason };
}

function confidenceOf(finding: FailureFindingRecord): FindingConfidence {
  if (finding.isLlm || finding.confidence === "llm") {
    return "low";
  }
  return finding.confidence;
}

/**
 * Generates hypotheses for every finding, most-frequent finding first, with at
 * most two alternatives per finding (a minimal edit and — where a graph change is
 * genuinely reasonable — a verification step).
 */
export function generateHypotheses(input: HypothesisGenerationInput): ProposedHypothesis[] {
  const definition = input.definition;
  if (definition === null) {
    return [];
  }
  const proposals: ProposedHypothesis[] = [];
  const claimedIds: string[] = [];
  const metricKeys = [input.objective.primary.metric, ...input.objective.secondary.map((spec) => spec.metric)];

  const output = outputNode(definition);
  const toolSelector = toolSelectingNode(definition);
  const loops = loopNodes(definition);
  const models = modelNodes(definition);
  const tools = requiredTools(input.evaluatorConfig);

  for (const finding of input.findings) {
    const category: FailureCategory = finding.category;
    const confidence = confidenceOf(finding);
    const base = {
      category,
      observation: finding.summary,
      findingIds: [finding.id],
      confidence,
      origin: input.origin ?? ("RULE_BASED" as const),
      acceptanceCriteria: {
        primaryMetric: input.objective.primary.metric,
        direction: input.objective.primary.direction,
        minImprovementPct: input.objective.minImprovementPct,
      } satisfies Record<string, unknown>,
    };

    const propose = (proposal: ProposedHypothesis): void => {
      proposals.push(proposal);
    };

    switch (category) {
      case "invalid_structured_output": {
        if (output === null) {
          break;
        }
        const field = textFieldFor(output);
        if (field === null) {
          break;
        }
        propose({
          ...base,
          title: `State the output contract on "${output.label ?? output.id}"`,
          hypothesis:
            "Output failures come from an implicit contract: naming the exact structure in the instructions should raise the structured-output pass rate.",
          proposedChange: `Append an explicit output contract to the ${field} of node "${output.id}".`,
          expectedOutcome: "Higher json_schema pass rate on the affected cases.",
          tradeoff: "A longer instruction costs a few tokens on every case.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              output,
              field,
              'Reply with a single JSON object only — no prose, no markdown fences. It must validate against the required output schema, and every required field must be present.',
              "Make the output contract explicit for cases whose structured output failed.",
            ),
          ],
        });
        break;
      }

      case "missing_required_information": {
        if (output === null || textFieldFor(output) === null) {
          break;
        }
        const field = textFieldFor(output) as "systemPrompt" | "template" | "instructions";
        propose({
          ...base,
          title: `Require the missing details on "${output.label ?? output.id}"`,
          hypothesis:
            "Answers omit required information because the instructions never demand it explicitly.",
          proposedChange: `Append an explicit completeness requirement to the ${field} of node "${output.id}".`,
          expectedOutcome: "Fewer cases missing required information; higher content pass rate.",
          tradeoff: "Slightly longer answers; a small token increase.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              output,
              field,
              "Before finishing, check that every required element is present: state each requested field explicitly, and say so plainly if the available evidence does not support it.",
              "Cases repeatedly omitted required information.",
            ),
          ],
        });
        break;
      }

      case "incorrect_final_answer": {
        if (output !== null && textFieldFor(output) !== null) {
          const field = textFieldFor(output) as "systemPrompt" | "template" | "instructions";
          propose({
            ...base,
            title: `Demand evidence before answering on "${output.label ?? output.id}"`,
            hypothesis:
              "Answers are wrong where the instructions allow unsupported claims; requiring evidence should reduce them.",
            proposedChange: `Append an evidence requirement to the ${field} of node "${output.id}".`,
            expectedOutcome: "Higher answer-correctness score on the failing cases.",
            tradeoff: "More tokens per answer; occasionally longer responses.",
            metricKeys,
            requiresReview: false,
            operations: [
              appendInstruction(
                output,
                field,
                "Base every claim on evidence you actually received. If the evidence is insufficient, say what is missing instead of guessing.",
                "Failing cases produced answers the evaluators judged incorrect.",
              ),
            ],
          });
        }
        const critique = insertCritic(
          definition,
          "Check the draft answer against the gathered evidence. If a claim is unsupported or a required element is missing, correct it before returning. Return only the corrected final answer.",
          "Add a verification step before the answer is returned.",
          claimedIds,
        );
        if (critique !== null) {
          claimedIds.push(critique.nodeId);
          propose({
            ...base,
            title: "Add a verification step before the answer",
            hypothesis:
              "A critic pass over the draft answer should catch the mistakes the evaluators keep finding.",
            proposedChange: "Insert a critic node between the answer-producing node and the exit node.",
            expectedOutcome: "Higher correctness, at the cost of one extra model call per case.",
            tradeoff: "Extra latency and tokens on every case — the more expensive of the two options.",
            metricKeys,
            requiresReview: input.gateGraphEdits ?? true,
            operations: [critique.op],
          });
        }
        break;
      }

      case "missing_tool_usage": {
        if (toolSelector === null || textFieldFor(toolSelector) === null) {
          break;
        }
        const field = textFieldFor(toolSelector) as "systemPrompt" | "template" | "instructions";
        const named = tools.length === 0 ? "the configured tool" : tools.map((tool) => `"${tool}"`).join(", ");
        propose({
          ...base,
          title: `Make ${named} mandatory when it is needed`,
          hypothesis:
            "A required tool goes unused because the instructions make it optional; naming the condition that requires it should fix that.",
          proposedChange: `Append tool-selection criteria to the ${field} of node "${toolSelector.id}".`,
          expectedOutcome: `Higher tool_usage pass rate for ${named}.`,
          tradeoff: "May add tool calls (and latency) on cases that previously answered directly.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              toolSelector,
              field,
              `Call ${named} before answering whenever the answer depends on external or computed facts. Do not answer from memory when the tool is available.`,
              "Cases failed the tool_usage evaluator because the required tool was never called.",
            ),
          ],
        });
        break;
      }

      case "inappropriate_tool_usage":
      case "excessive_tool_calls":
      case "repeated_tool_calls": {
        if (toolSelector === null || textFieldFor(toolSelector) === null) {
          break;
        }
        const field = textFieldFor(toolSelector) as "systemPrompt" | "template" | "instructions";
        propose({
          ...base,
          title: `Tighten tool selection on "${toolSelector.label ?? toolSelector.id}"`,
          hypothesis:
            "Tool misuse and repetition come from vague selection criteria; stating when each tool is appropriate (and when it is not) should reduce it.",
          proposedChange: `Append tool-selection policy to the ${field} of node "${toolSelector.id}".`,
          expectedOutcome: "Fewer unnecessary calls per case; lower cost and latency.",
          tradeoff: "Too strict a policy can under-call a tool the case needed.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              toolSelector,
              field,
              "Call a tool only when it is needed for the current step, and never repeat an identical call with the same arguments. If a result is already in state, reuse it.",
              "Cases showed inappropriate, excessive or repeated tool calls.",
            ),
          ],
        });
        break;
      }

      case "tool_error_recovery_failure": {
        const target = toolSelector ?? output;
        if (target === null || textFieldFor(target) === null) {
          break;
        }
        const field = textFieldFor(target) as "systemPrompt" | "template" | "instructions";
        propose({
          ...base,
          title: `Define recovery from a failed tool call`,
          hypothesis:
            "A tool failure ends the case because no recovery path is stated; an explicit fallback should keep cases alive.",
          proposedChange: `Append error-recovery instructions to the ${field} of node "${target.id}".`,
          expectedOutcome: "Fewer cases failing outright after a tool error.",
          tradeoff: "Recovery attempts cost calls; a pathological failure could loop without a bound.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              target,
              field,
              "If a tool call fails, do not stop. Retry once with corrected arguments; if it still fails, continue with the information available and state clearly what could not be retrieved.",
              "Cases ended on a tool error with no recovery.",
            ),
          ],
        });
        break;
      }

      case "excessive_loop_iterations": {
        const loop = loops[0];
        if (loop !== undefined) {
          const current = typeof loop.config["maxIterations"] === "number" ? (loop.config["maxIterations"] as number) : null;
          const halved = current === null ? null : Math.max(1, Math.floor(current / 2));
          const op = halved === null ? null : numericKnob(loop, "maxIterations", halved, "Curb an expensive loop bound.");
          if (op !== null) {
            propose({
              ...base,
              title: `Halve the loop bound on "${loop.label ?? loop.id}"`,
              hypothesis:
                "The loop spends iterations past the point of usefulness; a tighter bound should cut cost and latency without losing answers.",
              proposedChange: `Set maxIterations on node "${loop.id}" from ${current} to ${halved}.`,
              expectedOutcome: "Lower latency and token usage per case.",
              tradeoff: "A case that genuinely needed the extra iterations could terminate early.",
              metricKeys,
              requiresReview: false,
              operations: [op],
            });
          }
        }
        const planner = definition.nodes
          .map((node) => node as unknown as NodeLike)
          .find((node) => node.type === "planner");
        if (planner !== undefined && textFieldFor(planner) === "instructions") {
          propose({
            ...base,
            title: "State when the loop should stop",
            hypothesis:
              "Iterations continue because the stopping condition is implicit; stating it explicitly should end loops sooner.",
            proposedChange: `Append termination criteria to the instructions of node "${planner.id}".`,
            expectedOutcome: "Loops end as soon as the objective is met.",
            tradeoff: "Stopping earlier may leave marginal cases unresolved.",
            metricKeys,
            requiresReview: false,
            operations: [
              appendInstruction(
                planner,
                "instructions",
                "Stop iterating as soon as the objective is satisfied and the answer is complete; do not repeat a step whose result is already known.",
                "Loops ran well past the useful iteration count.",
              ),
            ],
          });
        }
        break;
      }

      case "premature_termination": {
        if (output === null || textFieldFor(output) === null) {
          break;
        }
        const field = textFieldFor(output) as "systemPrompt" | "template" | "instructions";
        propose({
          ...base,
          title: `Require a complete answer before ending`,
          hypothesis:
            "Runs stop early because nothing forces the final answer to be complete before the exit node.",
          proposedChange: `Append a completion requirement to the ${field} of node "${output.id}".`,
          expectedOutcome: "Fewer runs ending without a usable result.",
          tradeoff: "May add a model call on cases that already answered correctly.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              output,
              field,
              "Never return an empty or partial result: finish the task, and answer explicitly even when the evidence is incomplete.",
              "Cases terminated before producing a complete result.",
            ),
          ],
        });
        break;
      }

      case "termination_limit_exceeded": {
        const planner = definition.nodes
          .map((node) => node as unknown as NodeLike)
          .find((node) => node.type === "planner");
        if (planner !== undefined && textFieldFor(planner) === "instructions") {
          propose({
            ...base,
            title: "Work within the execution budget",
            hypothesis:
              "Runs hit a hard limit because the plan does not account for the budget; stating the budget should change the plan.",
            proposedChange: `Append budget-awareness to the instructions of node "${planner.id}".`,
            expectedOutcome: "Runs terminate on their own terms instead of being cut off.",
            tradeoff: "A more conservative plan may attempt less per case.",
            metricKeys,
            requiresReview: false,
            operations: [
              appendInstruction(
                planner,
                "instructions",
                "Plan for the limits you are given: prefer the shortest path that answers the question, and stop when you have enough evidence rather than using every available step.",
                "Cases hit an execution limit instead of finishing.",
              ),
            ],
          });
        }
        break;
      }

      case "excessive_latency":
      case "excessive_token_usage": {
        const model = models[0];
        const knob =
          model === undefined
            ? null
            : typeof model.config["maxTokens"] === "number" && (model.config["maxTokens"] as number) > 512
              ? numericKnob(
                  model,
                  "maxTokens",
                  Math.max(512, Math.floor((model.config["maxTokens"] as number) / 2)),
                  "Halve the response budget on the slowest node.",
                )
              : null;
        if (knob !== null && model !== undefined) {
          propose({
            ...base,
            title: `Reduce the response budget on "${model.label ?? model.id}"`,
            hypothesis:
              "Long generations dominate cost and latency; a tighter response budget should cut both.",
            proposedChange: `Lower maxTokens on node "${model.id}".`,
            expectedOutcome: "Lower tokens and latency per case.",
            tradeoff: "Truncated generations could hurt correctness on cases that need long answers.",
            metricKeys,
            requiresReview: false,
            operations: [knob],
          });
        }
        if (output !== null && textFieldFor(output) !== null) {
          const field = textFieldFor(output) as "systemPrompt" | "template" | "instructions";
          propose({
            ...base,
            title: "Ask for concise answers",
            hypothesis:
              "Verbose answers inflate tokens and latency without improving scores; asking for concision should reduce both.",
            proposedChange: `Append a concision requirement to the ${field} of node "${output.id}".`,
            expectedOutcome: "Lower token usage and latency; unchanged correctness.",
            tradeoff: "Brevity can omit nuance the evaluators reward.",
            metricKeys,
            requiresReview: false,
            operations: [
              appendInstruction(
                output,
                field,
                "Answer concisely: state the result, then only the evidence needed to support it. Do not restate the question or repeat prior steps.",
                "Latency and token usage were far above the batch norm.",
              ),
            ],
          });
        }
        break;
      }

      case "harness_policy_violation": {
        if (output === null || textFieldFor(output) === null) {
          break;
        }
        const field = textFieldFor(output) as "systemPrompt" | "template" | "instructions";
        propose({
          ...base,
          title: "Restate the harness policy in the instructions",
          hypothesis:
            "Declared behaviour is not observed because the policy is not stated where the model reads it.",
          proposedChange: `Append the policy requirement to the ${field} of node "${output.id}".`,
          expectedOutcome: "Higher harness_compliance pass rate.",
          tradeoff: "A longer system prompt on every call.",
          metricKeys,
          requiresReview: false,
          operations: [
            appendInstruction(
              output,
              field,
              "Follow the harness policy exactly: use only the tools you are given, respect their declared bounds, and never invent tool results or steps.",
              "The compliance evaluator recorded a policy violation.",
            ),
          ],
        });
        break;
      }

      case "inconsistent_trials": {
        const model = models[0];
        const current = model === undefined ? null : model.config["temperature"];
        const targetTemperature =
          typeof current === "number" && current > 0 ? Math.max(0, Math.min(current, 0.2)) : null;
        const knob =
          model === undefined || targetTemperature === null
            ? null
            : numericKnob(model, "temperature", targetTemperature, "Reduce sampling variance.");
        if (knob !== null && model !== undefined) {
          propose({
            ...base,
            title: `Reduce sampling variance on "${model.label ?? model.id}"`,
            hypothesis:
              "Trials disagree because sampling is loose; lowering temperature should make behaviour repeatable.",
            proposedChange: `Lower temperature on node "${model.id}" from ${String(current)} to ${targetTemperature}.`,
            expectedOutcome: "Consistent behavior across repeated trials.",
            tradeoff: "Lower temperature can reduce creative quality on open-ended cases.",
            metricKeys,
            requiresReview: false,
            operations: [knob],
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return proposals;
}
