import { z } from "zod";
import { LLMProviderError } from "@/modules/llm/llm.types";
import { estimateCostUsd } from "@/modules/runtime/usage/tracker";
import { EvaluatorError, type EvaluationInput, type EvaluationOutcome } from "../evaluation.types";
import { EvaluatorConfigInvalid, preview, toText, type EvaluatorDefinition } from "./contract";

/**
 * LLM-as-judge evaluator (optional).
 *
 * Requirements this implementation takes literally:
 *  - a **rubric** is mandatory — a judge without criteria is a coin flip;
 *  - the judge returns **structured JSON**, which is parsed and validated, never
 *    trusted as free text;
 *  - malformed responses, timeouts and provider failures are *errors*, reported
 *    as such, and never silently become a passing score;
 *  - the verdict is labelled as a judgement (`metadata.judgement = true`, and
 *    the explanation is prefixed), so nobody reads it as objective truth;
 *  - judge token usage, latency and estimated cost are recorded separately from
 *    the agent run's usage (they live in the result's metadata).
 *
 * Deterministic properties (exact match, schema validity, tool usage, workflow
 * compliance) must be evaluated by the deterministic evaluators — this one is
 * for qualities no rule can express.
 */

const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

export const llmJudgeConfigSchema = z.strictObject({
  /** The criteria the judge must apply. */
  rubric: z.string().min(10).max(4_000),
  /** "provider:model" reference — validated by the gateway at run time. */
  model: z.string().min(3).max(160),
  /** Score at or above which the answer passes. */
  minScore: z.number().min(0).max(1).default(0.7),
  /** Include the dataset's reference answer when one exists. */
  includeExpected: z.boolean().default(true),
  /** Budget for the judge call. */
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
// Note: the response-size cap is a platform ceiling, not a per-evaluator knob,
// so it is not configurable here (see MAX_RESPONSE_CHARS below).

export type LlmJudgeConfig = z.infer<typeof llmJudgeConfigSchema>;

/** Hard cap on how much untrusted judge text is parsed and stored. */
export const MAX_RESPONSE_CHARS = DEFAULT_MAX_RESPONSE_CHARS;

/** The shape the judge must return. Anything else is a malformed response. */
export const judgeVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  verdict: z.string().max(500).optional(),
  explanation: z.string().min(1).max(4_000),
  criteria: z
    .array(z.object({ criterion: z.string().max(300), met: z.boolean() }))
    .max(20)
    .optional(),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const SYSTEM_PROMPT = [
  "You are an evaluation judge for an AI agent platform.",
  "Judge the agent's final answer against the supplied rubric and return STRICT JSON only.",
  "Return exactly this shape:",
  '{"score": <number between 0 and 1>, "verdict": "<one short sentence>", "explanation": "<why, referencing the rubric>", "criteria": [{"criterion": "<rubric criterion>", "met": <true|false>}]}',
  "Do not add commentary outside the JSON. Do not wrap the JSON in markdown fences.",
  "Score 1 means the rubric is fully satisfied; 0 means it is not satisfied at all.",
  "Be strict and specific: cite what the answer did or failed to do.",
].join("\n");

export function buildJudgePrompt(
  input: EvaluationInput,
  config: LlmJudgeConfig,
): string {
  const sections = [
    "## Rubric",
    config.rubric,
    "",
    "## Task given to the agent",
    preview(toText(input.task), 4_000),
    "",
    "## Agent's final answer",
    preview(toText(input.output), 8_000),
  ];
  if (config.includeExpected && input.expectedOutput !== null && input.expectedOutput !== undefined) {
    sections.push("", "## Reference answer (not the only acceptable answer)", preview(toText(input.expectedOutput), 4_000));
  }
  if (input.run.error !== null) {
    sections.push(
      "",
      `## Note: the run ended with an error (${input.run.error.code}). Judge the answer anyway, but say so in the explanation if the failure explains a gap.`,
    );
  }
  sections.push("", "Return the JSON verdict now.");
  return sections.join("\n");
}

/** Extracts the JSON verdict from a response that may include fences/prose. */
export function parseJudgeResponse(
  content: string,
): { ok: true; verdict: JudgeVerdict } | { ok: false; error: string } {
  const text = content.trim();
  if (text === "") {
    return { ok: false, error: "The judge returned an empty response" };
  }
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) {
    candidates.push(fence[1].trim());
  }
  candidates.push(text);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    const result = judgeVerdictSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, verdict: result.data };
    }
    return {
      ok: false,
      error: `The judge's JSON does not match the required shape: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: false, error: "The judge's response was not valid JSON" };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Judge call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const llmJudgeEvaluator: EvaluatorDefinition<LlmJudgeConfig> = {
  kind: "llm_judge",
  label: "LLM judge",
  description: "Asks a model to score the answer against an explicit rubric (a judgement, not a fact).",
  usesLlm: true,
  configSchema: llmJudgeConfigSchema,
  configFields: [
    { name: "rubric", label: "Rubric", type: "string", required: true, description: "The criteria the judge applies." },
    { name: "model", label: "Judge model", type: "model", required: true, description: "provider:model, e.g. gemini:gemini-2.0-flash" },
    { name: "minScore", label: "Pass score", type: "number", default: 0.7 },
    { name: "includeExpected", label: "Include reference answer", type: "boolean", default: true },
    { name: "timeoutMs", label: "Timeout (ms)", type: "number", default: 30_000 },
  ],
  defaultConfig: {
    rubric: "The answer must directly address the task, be factually consistent with the provided material, and avoid unsupported claims.",
    model: "gemini:gemini-2.0-flash",
    minScore: 0.7,
    includeExpected: true,
    timeoutMs: 30_000,
  },

  async evaluate(input: EvaluationInput, context, config): Promise<EvaluationOutcome> {
    if (context.llm === undefined) {
      throw new EvaluatorConfigInvalid(
        "The LLM judge needs a model gateway, but none was provided to this evaluation context.",
      );
    }
    const maxChars = context.maxResponseChars ?? MAX_RESPONSE_CHARS;

    const startedAt = context.now();
    let response;
    try {
      response = await withTimeout(
        context.llm.gateway.generate(config.model, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildJudgePrompt(input, config) },
          ],
          temperature: 0,
          responseFormat: "json",
          metadata: {
            evaluator: "llm_judge",
            runId: input.run.runId,
            caseKey: context.caseKey,
          },
        }),
        config.timeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof LLMProviderError
          ? error.retryable
          : !message.includes("exceeded");
      throw new EvaluatorError(
        context.evaluatorKey,
        `The judge model ("${config.model}") could not be reached: ${message}`,
        { retryable, cause: error },
      );
    }

    const durationMs = context.now().getTime() - startedAt.getTime();
    const costUsd = estimateCostUsd(response.provider, response.model, response.usage);

    if (response.content.length > maxChars) {
      throw new EvaluatorError(
        context.evaluatorKey,
        `The judge returned ${response.content.length} characters, above the ${maxChars} character ceiling — the response was discarded rather than truncated into a misleading verdict.`,
        { retryable: false },
      );
    }

    const parsed = parseJudgeResponse(response.content);
    if (!parsed.ok) {
      throw new EvaluatorError(context.evaluatorKey, parsed.error, { retryable: true });
    }

    const verdict = parsed.verdict;
    const passed = verdict.score >= config.minScore;
    const metCount = verdict.criteria?.filter((entry) => entry.met).length ?? null;

    return {
      status: "COMPLETED",
      score: verdict.score,
      maxScore: 1,
      passed,
      explanation: `LLM judge (${response.provider}:${response.model}) scored ${verdict.score.toFixed(2)} against ${config.minScore.toFixed(2)} pass mark — ${
        verdict.verdict ?? (passed ? "rubric satisfied" : "rubric not satisfied")
      }. ${verdict.explanation}`.trim(),
      evidence: {
        judgement: true,
        rubric: config.rubric,
        verdict: verdict.verdict ?? null,
        criteria: verdict.criteria ?? null,
        criteriaMet: metCount,
        model: `${response.provider}:${response.model}`,
      },
      metadata: {
        judgement: true,
        provider: response.provider,
        // Fully-qualified so an accounting report can name the model without
        // guessing which provider served it.
        model: `${response.provider}:${response.model}`,
        modelId: response.model,
        latencyMs: durationMs,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        // Judge cost is accounted separately from the agent run's usage.
        costUsd,
        costKind: "estimated",
        minScore: config.minScore,
      },
    };
  },
};
