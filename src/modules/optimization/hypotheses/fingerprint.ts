import { hashJson } from "@/modules/evaluation/hashing";
import type { ProposedHypothesis } from "../optimization.types";

/**
 * A hypothesis's identity.
 *
 * It hashes the *effect* of the proposal — the claim and the exact operations —
 * not its prose. That gives the loop two properties it needs:
 *
 *  - the same observation cannot be proposed twice in one session (a unique
 *    index enforces it, so a redelivered pass cannot duplicate a hypothesis);
 *  - a stored hypothesis can be matched back to the deterministic rule that
 *    produced it, so its operations do not have to be persisted a second time.
 */
export function hypothesisFingerprint(proposal: ProposedHypothesis): string {
  return hashJson({
    category: proposal.category,
    title: proposal.title,
    operations: proposal.operations,
  });
}
