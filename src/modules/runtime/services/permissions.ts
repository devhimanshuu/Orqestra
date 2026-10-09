/**
 * Tool permission layer.
 *
 * Every tool call passes through `ToolPermissionPolicy.assertAllowed()` before
 * the registry is touched. This is deliberately its own module: agent
 * governance (approvals, rate classes, environments) grows here later without
 * touching tool execution.
 *
 * Phase 2 policy semantics:
 *  - `mode: "allow_all"`    — harness decides; used for harness-only runs and
 *                             agents that declare no capabilities.
 *  - `mode: "allowlist"`    — only ids in `allowed` may run (this is what an
 *                             agent's `capabilities` list becomes).
 *  - `denied` always wins, in both modes.
 */

import { PermissionError } from "../errors/runtime-error";

export interface ToolPermissionPolicy {
  mode: "allow_all" | "allowlist";
  /** Tool ids permitted in allowlist mode. Ignored when mode is allow_all. */
  allowed: string[];
  /** Tool ids refused regardless of mode (explicit denials, e.g. by policy). */
  denied: string[];
}

export const ALLOW_ALL_TOOLS: ToolPermissionPolicy = {
  mode: "allow_all",
  allowed: [],
  denied: [],
};

export function allowlistFromCapabilities(capabilities: string[]): ToolPermissionPolicy {
  const unique = [...new Set(capabilities.map((id) => id.trim()).filter((id) => id !== ""))];
  if (unique.length === 0) {
    return ALLOW_ALL_TOOLS;
  }
  return { mode: "allowlist", allowed: unique, denied: [] };
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

export function decideToolPermission(
  policy: ToolPermissionPolicy,
  toolId: string,
): PermissionDecision {
  if (policy.denied.includes(toolId)) {
    return { allowed: false, reason: `tool "${toolId}" is explicitly denied for this run` };
  }
  if (policy.mode === "allowlist" && !policy.allowed.includes(toolId)) {
    return {
      allowed: false,
      reason: `tool "${toolId}" is not in the run's allowed tools (${
        policy.allowed.length > 0 ? policy.allowed.join(", ") : "none"
      })`,
    };
  }
  return { allowed: true, reason: "allowed" };
}

/** Throws PermissionError when the tool may not run. */
export function assertToolAllowed(
  policy: ToolPermissionPolicy,
  toolId: string,
  nodeId: string,
): void {
  const decision = decideToolPermission(policy, toolId);
  if (!decision.allowed) {
    throw new PermissionError(`Permission denied: ${decision.reason}`, {
      nodeId,
      details: { toolId, mode: policy.mode },
    });
  }
}
