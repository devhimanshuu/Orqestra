/**
 * Statistical comparison.
 *
 * Focused on purpose: the question an experiment answers is "did this candidate
 * beat the baseline on the same test cases?" — a *paired* question, because every
 * candidate ran the identical dataset cases. So the tool here is a paired
 * analysis, and the module says loudly when the data cannot support a claim.
 *
 * Method (documented, because a number without a method is not evidence):
 *
 *   - **Paired differences.** For each case scored on both sides, d = candidate −
 *     baseline. Cases missing on either side are excluded from the test and
 *     reported through `alignment`, never imputed.
 *   - **t-interval (95%).** mean(d) ± t(0.975, n−1) · sd(d)/√n. Bounded scores
 *     (0…1) can have heavier tails than a normal distribution, so the
 *     nonparametric sign test is reported alongside it: if the two disagree, the
 *     evidence is called inconclusive rather than picking the flattering one.
 *   - **Sign test.** Two-sided exact binomial on the number of positive vs
 *     negative differences (ties dropped), falling back to a normal
 *     approximation above 200 pairs.
 *   - **Minimum sample.** Fewer than {@link MIN_PAIRED_SAMPLE} paired cases ⇒
 *     `insufficient_sample`. No significance claim is ever made from a handful of
 *     runs; the verdict says so explicitly.
 *
 * Assumptions are returned with every result so the UI can show its work.
 */

const DEFAULT_CONFIDENCE = 0.95;

/** Below this many paired cases, no statistical claim is made at all. */
export const MIN_PAIRED_SAMPLE = 8;

/** Two-sided t critical values (0.975 quantile) for small samples. */
const T_CRITICAL_975: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  21: 2.08,
  22: 2.074,
  23: 2.069,
  24: 2.064,
  25: 2.06,
  26: 2.056,
  27: 2.052,
  28: 2.048,
  29: 2.045,
  30: 2.042,
};

function tCritical(df: number): number {
  if (df < 1) {
    return Number.NaN;
  }
  return T_CRITICAL_975[df] ?? 1.96;
}

export interface PairedDifference {
  caseKey: string;
  baseline: number | null;
  candidate: number | null;
  /** candidate − baseline, or null when either side is missing. */
  difference: number | null;
}

export interface PairedSummary {
  method: "paired-t";
  confidenceLevel: number;
  /** Paired cases used by the test. */
  n: number;
  meanDifference: number | null;
  standardDeviation: number | null;
  standardError: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** True when n ≥ the documented minimum sample. */
  sufficientSample: boolean;
  minSample: number;
  assumptions: string[];
  notes: string[];
}

export interface SignTestResult {
  positive: number;
  negative: number;
  ties: number;
  n: number;
  /** Two-sided p-value, or null when there is nothing to test. */
  pValue: number | null;
  method: "exact-binomial" | "normal-approximation" | "not-applicable";
}

export type EvidenceVerdict =
  | "supported_improvement"
  | "supported_regression"
  | "inconclusive"
  | "insufficient_sample"
  | "no_difference";

export interface EvidenceAssessment {
  verdict: EvidenceVerdict;
  /** Whether a higher value is better for the metric being assessed. */
  higherIsBetter: boolean;
  paired: PairedSummary;
  signTest: SignTestResult;
  explanation: string;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

/** Paired t-interval on the differences that were measured on both sides. */
export function pairedTInterval(
  differences: readonly PairedDifference[],
  options: { confidenceLevel?: number; minSample?: number } = {},
): PairedSummary {
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE;
  const minSample = options.minSample ?? MIN_PAIRED_SAMPLE;
  const values = differences
    .map((entry) => entry.difference)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const assumptions = [
    "Cases are paired: the same dataset case is executed by both sides.",
    "Differences are treated as roughly independent and symmetrically distributed; bounded scores can have heavier tails, which is why a sign test is also reported.",
  ];

  if (values.length === 0) {
    return {
      method: "paired-t",
      confidenceLevel,
      n: 0,
      meanDifference: null,
      standardDeviation: null,
      standardError: null,
      ciLow: null,
      ciHigh: null,
      sufficientSample: false,
      minSample,
      assumptions,
      notes: ["No case was scored on both sides, so no paired comparison is possible."],
    };
  }

  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n === 1 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const standardDeviation = Math.sqrt(variance);
  const standardError = standardDeviation / Math.sqrt(n);
  const critical = n === 1 ? Number.NaN : tCritical(n - 1);
  const halfWidth = Number.isFinite(critical) ? critical * standardError : null;

  const notes: string[] = [];
  if (n < minSample) {
    notes.push(
      `Only ${n} paired case(s); a statistical claim needs at least ${minSample}. The difference is reported as an observation, not as significance.`,
    );
  }
  if (standardDeviation === 0) {
    notes.push("Every paired case moved by the same amount (zero variance).");
  }

  return {
    method: "paired-t",
    confidenceLevel,
    n,
    meanDifference: round(mean),
    standardDeviation: round(standardDeviation),
    standardError: round(standardError),
    ciLow: halfWidth === null ? null : round(mean - halfWidth),
    ciHigh: halfWidth === null ? null : round(mean + halfWidth),
    sufficientSample: n >= minSample,
    minSample,
    assumptions,
    notes,
  };
}

function logFactorial(n: number): number {
  let sum = 0;
  for (let index = 2; index <= n; index += 1) {
    sum += Math.log(index);
  }
  return sum;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** Two-sided sign test on paired differences; ties (zero differences) are dropped. */
export function signTest(differences: readonly PairedDifference[]): SignTestResult {
  const values = differences
    .map((entry) => entry.difference)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const positive = values.filter((value) => value > 0).length;
  const negative = values.filter((value) => value < 0).length;
  const ties = values.filter((value) => value === 0).length;
  const n = positive + negative;

  if (n === 0) {
    return { positive, negative, ties, n, pValue: null, method: "not-applicable" };
  }

  const k = Math.min(positive, negative);

  if (n > 200) {
    // Normal approximation with continuity correction.
    const mean = n / 2;
    const sd = Math.sqrt((n * 0.5 * 0.5));
    const z = (Math.abs(k - mean) - 0.5) / sd;
    const pValue = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
    return { positive, negative, ties, n, pValue: round(pValue, 6), method: "normal-approximation" };
  }

  const logHalf = n * Math.log(0.5);
  let tail = 0;
  for (let index = 0; index <= k; index += 1) {
    tail += Math.exp(logChoose(n, index) + logHalf);
  }
  const pValue = Math.min(1, 2 * tail);
  return { positive, negative, ties, n, pValue: round(pValue, 6), method: "exact-binomial" };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 error-function approximation). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const probability =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - probability : probability;
}

/**
 * Turns paired differences into a verdict.
 *
 * Words, not p-values, drive the result: "supported" requires the whole
 * confidence interval to sit on the candidate's side *and* the sign test not to
 * contradict it; everything else is inconclusive or plainly insufficient — never
 * a manufactured certainty.
 */
export function assessEvidence(input: {
  differences: readonly PairedDifference[];
  higherIsBetter: boolean;
  minSample?: number;
}): EvidenceAssessment {
  const paired = pairedTInterval(input.differences, input.minSample === undefined ? {} : { minSample: input.minSample });
  const sign = signTest(input.differences);
  const direction = (value: number): "improvement" | "regression" =>
    (value > 0) === input.higherIsBetter ? "improvement" : "regression";

  if (paired.n === 0) {
    return {
      verdict: "insufficient_sample",
      higherIsBetter: input.higherIsBetter,
      paired,
      signTest: sign,
      explanation:
        "No test case has a score on both sides yet, so no comparison can be made. Run the experiment to completion first.",
    };
  }

  if (!paired.sufficientSample) {
    const mean = paired.meanDifference;
    const side = mean === null || mean === 0 ? "no measurable movement" : `${direction(mean) === "improvement" ? "an improvement" : "a regression"} of ${Math.abs(mean).toFixed(3)}`;
    return {
      verdict: "insufficient_sample",
      higherIsBetter: input.higherIsBetter,
      paired,
      signTest: sign,
      explanation: `Observed ${side} across ${paired.n} paired case(s), but ${paired.minSample} are needed before a statistical claim is made. Treat this as provisional.`,
    };
  }

  if (
    meanIsZero(input.differences) ||
    (paired.ciLow !== null && paired.ciHigh !== null && paired.ciLow === 0 && paired.ciHigh === 0)
  ) {
    return {
      verdict: "no_difference",
      higherIsBetter: input.higherIsBetter,
      paired,
      signTest: sign,
      explanation: `All ${paired.n} paired case(s) scored identically on both sides.`,
    };
  }

  const ciLow = paired.ciLow;
  const ciHigh = paired.ciHigh;
  const higher = input.higherIsBetter;
  const supportedImprovement = ciLow !== null && (higher ? ciLow > 0 : ciHigh !== null && ciHigh < 0);
  const supportedRegression = ciHigh !== null && (higher ? ciHigh < 0 : ciLow !== null && ciLow > 0);
  // A difference > 0 means the candidate scored higher than the baseline. On a
  // *maximize* metric that is an improvement; on a *minimize* metric it is a
  // regression. The sign test therefore corroborates an improvement when the
  // differences lean toward "higher is better for this metric", and a regression
  // when they lean the other way — the direction flips with the metric, and this
  // used to be inverted, which turned every supported regression into
  // "inconclusive".
  const leansTowardCandidate = sign.positive > sign.negative;
  const significant = sign.pValue !== null && sign.pValue < 0.05;
  const improvementAgrees = leansTowardCandidate === higher;
  const signAgreesImprovement = significant && improvementAgrees;
  const signAgreesRegression = significant && !improvementAgrees;

  if (supportedImprovement && signAgreesImprovement) {
    return {
      verdict: "supported_improvement",
      higherIsBetter: higher,
      paired,
      signTest: sign,
      explanation: `Paired mean difference ${(paired.meanDifference ?? 0).toFixed(3)} with a 95% interval [${ciLow?.toFixed(3)}, ${ciHigh?.toFixed(3)}] entirely on the candidate's side, and the sign test agrees (p=${sign.pValue?.toFixed(3)}).`,
    };
  }

  if (supportedRegression && signAgreesRegression) {
    return {
      verdict: "supported_regression",
      higherIsBetter: higher,
      paired,
      signTest: sign,
      explanation: `Paired mean difference ${(paired.meanDifference ?? 0).toFixed(3)} with a 95% interval [${ciLow?.toFixed(3)}, ${ciHigh?.toFixed(3)}] pointing the wrong way, and the sign test agrees (p=${sign.pValue?.toFixed(3)}).`,
    };
  }

  const agreement = supportedImprovement || supportedRegression ? "" : " The interval still crosses zero.";
  const signNote =
    sign.pValue === null
      ? ""
      : ` The sign test does not corroborate it (p=${sign.pValue.toFixed(3)}).`;
  return {
    verdict: "inconclusive",
    higherIsBetter: higher,
    paired,
    signTest: sign,
    explanation: `The evidence is inconclusive: mean paired difference ${paired.meanDifference === null ? "n/a" : paired.meanDifference.toFixed(3)} across ${paired.n} case(s).${agreement}${signNote}`,
  };
}

function meanIsZero(differences: readonly PairedDifference[]): boolean {
  const values = differences
    .map((entry) => entry.difference)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length > 0 && values.every((value) => Math.abs(value) < 1e-12);
}

/**
 * A conveniently formatted interval, or an honest dash. Used by the UI and the
 * JSON/CSV exports so both render the same numbers.
 */
export function formatInterval(summary: PairedSummary): string {
  if (summary.ciLow === null || summary.ciHigh === null) {
    return "—";
  }
  return `[${summary.ciLow.toFixed(3)}, ${summary.ciHigh.toFixed(3)}]`;
}
