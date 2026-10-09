/**
 * Per-run service container.
 *
 * One factory, created once per run, assembling every capability a node
 * executor may use: LLM, tools, limits, memory, agent context, clock, signal.
 * Executors receive this object; they never import a gateway, a registry, or a
 * client — which is exactly what makes the runtime unit-testable with fakes and
 * portable off Next.js.
 */

import type { Logger } from "@/lib/logging/logger";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { ToolRegistry } from "@/modules/tools/tool.registry";
import type { RuntimeEventEmitter } from "../events/event-emitter";
import type { LimitTracker } from "../policies/limits";
import type { RetryPolicy } from "../policies/retry";
import type { ExecutionState } from "../state/execution-state";
import type { UsageTracker } from "../usage/tracker";
import type { RuntimeAgentContext, RuntimeNodeServices } from "../nodes/node-executor";
import { RuntimeLlmService } from "./llm-service";
import { RuntimeToolService } from "./tool-service";
import { RunMemoryStore } from "./memory";
import type { ToolPermissionPolicy } from "./permissions";

export interface CreateRuntimeServicesInput {
  gateway: LLMGateway;
  toolRegistry: ToolRegistry;
  permissions: ToolPermissionPolicy;
  emitter: RuntimeEventEmitter;
  limits: LimitTracker;
  usage: UsageTracker;
  logger: Logger;
  signal: AbortSignal;
  now: () => Date;
  state: ExecutionState;
  agent: RuntimeAgentContext | null;
  retryPolicy?: RetryPolicy;
  llmTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** Invoked whenever a model call contributes cost (used for cost-limit tracing). */
  onCost?: (costUsd: number | null) => void;
  onToolCallAccepted?: (toolId: string) => void;
}

export interface RuntimeServices {
  services: RuntimeNodeServices;
  llm: RuntimeLlmService;
  tools: RuntimeToolService;
  memory: RunMemoryStore;
}

export function createRuntimeServices(input: CreateRuntimeServicesInput): RuntimeServices {
  const memory = new RunMemoryStore();

  const llm = new RuntimeLlmService({
    gateway: input.gateway,
    emitter: input.emitter,
    limits: input.limits,
    usage: input.usage,
    logger: input.logger,
    signal: input.signal,
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.llmTimeoutMs !== undefined ? { callTimeoutMs: input.llmTimeoutMs } : {}),
    ...(input.onCost !== undefined ? { onCost: input.onCost } : {}),
  });

  const tools = new RuntimeToolService({
    registry: input.toolRegistry,
    permissions: input.permissions,
    emitter: input.emitter,
    limits: input.limits,
    logger: input.logger,
    signal: input.signal,
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.toolTimeoutMs !== undefined ? { callTimeoutMs: input.toolTimeoutMs } : {}),
    ...(input.onToolCallAccepted !== undefined ? { onCallAccepted: input.onToolCallAccepted } : {}),
  });

  const services: RuntimeNodeServices = {
    llm,
    tools,
    limits: input.limits,
    memory,
    agent: input.agent,
    logger: input.logger,
    signal: input.signal,
    now: input.now,
    state: input.state,
  };

  return { services, llm, tools, memory };
}
