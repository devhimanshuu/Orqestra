/**
 * Node executor registry.
 *
 * The engine never switches on node type: it asks the registry. Registration
 * asserts that a type is claimed exactly once, so a duplicated or missing
 * executor is a startup error rather than a mid-run surprise. Adding a node type
 * to the DSL without an executor breaks the runtime's contract test
 * (`registry.test.ts`), which is the point.
 */

import { HARNESS_NODE_TYPES, type HarnessNodeType } from "@/modules/harness/harness.schema";
import { InternalRuntimeError } from "../errors/runtime-error";
import type { NodeExecutor, RuntimeNode } from "./node-executor";
import { startExecutor, endExecutor } from "./control-nodes";
import { aiExecutors } from "./ai-nodes";
import { toolExecutor } from "./tool-nodes";
import { contextExecutor, memoryExecutor } from "./context-nodes";
import { logicExecutors } from "./logic-nodes";

export class NodeExecutorRegistry {
  private readonly executors = new Map<HarnessNodeType, NodeExecutor>();

  register(executor: NodeExecutor): void {
    if (this.executors.has(executor.type)) {
      throw new InternalRuntimeError(`Executor for node type "${executor.type}" is already registered`);
    }
    this.executors.set(executor.type, executor);
  }

  has(type: HarnessNodeType): boolean {
    return this.executors.has(type);
  }

  get(type: HarnessNodeType): NodeExecutor {
    const executor = this.executors.get(type);
    if (executor === undefined) {
      throw new InternalRuntimeError(`No executor registered for node type "${type}"`);
    }
    return executor;
  }

  types(): HarnessNodeType[] {
    return [...this.executors.keys()];
  }

  /** Runs an executor's config validation (compile-time sanity check). */
  validate(node: RuntimeNode): void {
    this.get(node.type).validate(node.config, node);
  }
}

/** Builds the default registry. Exported for tests and future plugin registration. */
export function createNodeExecutorRegistry(): NodeExecutorRegistry {
  const registry = new NodeExecutorRegistry();
  for (const executor of [
    startExecutor,
    endExecutor,
    ...aiExecutors,
    toolExecutor,
    contextExecutor,
    memoryExecutor,
    ...logicExecutors,
  ]) {
    registry.register(executor);
  }
  return registry;
}

let defaultRegistry: NodeExecutorRegistry | null = null;

/** Process-wide registry (executors are stateless — one instance is enough). */
export function getNodeExecutorRegistry(): NodeExecutorRegistry {
  if (defaultRegistry === null) {
    defaultRegistry = createNodeExecutorRegistry();
  }
  return defaultRegistry;
}

/** Node types the DSL declares, exposed so tests can assert registry parity. */
export const DSL_NODE_TYPES: readonly HarnessNodeType[] = HARNESS_NODE_TYPES;
