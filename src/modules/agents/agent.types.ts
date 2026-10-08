/**
 * Agent domain concepts.
 *
 * An Agent is *who the agent is*: identity, purpose, base instructions,
 * model configuration, capabilities. It never encodes *how* the agent
 * behaves step by step — that is the Harness (src/modules/harness).
 *
 * AgentVersion rows are immutable snapshots, mirroring HarnessVersion, so a
 * run can pin the exact agent configuration that produced it.
 */

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Model selection passed through to the LLM gateway — never a provider SDK type. */
export interface AgentModelConfig {
  /** e.g. "gemini:gemini-2.0-flash" or "ollama:llama3.1". */
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  /** What the agent is for, in one or two sentences. */
  purpose: string | null;
  /** Base instructions — the agent's standing "job description". */
  instructions: string;
  modelConfig: AgentModelConfig;
  /** Declared tool/capability ids the agent may use (harness decides when). */
  capabilities: string[];
  createdBy: string | null;
  createdAt: Date;
}

/** List/overview projection: agent plus the latest version's configuration. */
export interface AgentSummary extends Agent {
  purpose: string | null;
  modelConfig: AgentModelConfig;
  harnessCount: number;
}

/** Full overview payload for the agent page. */
export interface AgentOverview extends Agent {
  latestVersion: AgentVersion;
  harnesses: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    currentVersion: number;
    updatedAt: Date;
    nodeCount: number;
  }>;
  runCount: number;
  versionCount: number;
}

export interface CreateAgentInput {
  projectId: string;
  name: string;
  slug?: string;
  description?: string;
  purpose?: string;
  instructions: string;
  modelConfig: AgentModelConfig;
  capabilities?: string[];
  createdBy?: string;
}

/** Editing an agent always produces a new immutable AgentVersion. */
export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  purpose?: string;
  instructions: string;
  modelConfig: AgentModelConfig;
  capabilities?: string[];
  createdBy?: string;
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" not found`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}
