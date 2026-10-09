"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Bot, ChevronRight, Network, Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status-badge";

const NATIVE_SELECT =
  "h-8 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40";

export interface AgentSummaryDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  purpose: string | null;
  currentVersion: number;
  modelConfig: { model: string; temperature?: number; maxTokens?: number };
  harnessCount: number;
}

export interface HarnessSummaryDto {
  id: string;
  name: string;
  slug: string;
  agentId: string | null;
  status: string;
  currentVersion: number;
  nodeCount: number;
  edgeCount: number;
}

const MODEL_CHOICES = [
  { value: "gemini:gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { value: "gemini:gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "ollama:llama3.1", label: "Ollama · Llama 3.1" },
  { value: "groq:llama-3.3-70b-versatile", label: "Groq · Llama 3.3 70B" },
  { value: "openai:gpt-4o-mini", label: "OpenAI · GPT-4o mini" },
  { value: "anthropic:claude-sonnet-4", label: "Anthropic · Claude Sonnet 4" },
];

/**
 * Project detail: agents first (the product flow is project → agent → harness),
 * harnesses below for orientation. All mutations go through /api.
 */
export function ProjectDetailView({
  projectId,
  agents,
  harnesses,
}: {
  projectId: string;
  agents: AgentSummaryDto[];
  harnesses: HarnessSummaryDto[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
            <p className="text-sm text-muted-foreground">
              The agent is the identity — the harness controls its behavior.
            </p>
          </div>
          <CreateAgentDialog projectId={projectId} />
        </div>

        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center">
            <Bot className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No agents yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create your first agent and design its execution harness.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="agent-list">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/dashboard/agents/${agent.id}`}
                data-testid={`agent-card-${agent.slug}`}
                className="group rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-primary/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 truncate text-sm font-semibold">
                    <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {agent.name}
                  </h3>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    v{agent.currentVersion}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                  {agent.description ?? agent.purpose ?? "No description yet."}
                </p>
                <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span className="font-mono">{agent.modelConfig.model}</span>
                  <span className="flex items-center gap-1">
                    <Network className="h-3 w-3" />
                    {agent.harnessCount} harness{agent.harnessCount === 1 ? "" : "es"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Harnesses</h2>
            <p className="text-sm text-muted-foreground">
              Every harness belongs to an agent and versioning keeps history immutable.
            </p>
          </div>
          <CreateHarnessDialog agents={agents} />
        </div>

        {harnesses.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No harness yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Build your agent&apos;s behavior visually — create an agent first, then its harness.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border" data-testid="harness-list">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Harness</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Graph</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {harnesses.map((harness) => (
                  <tr
                    key={harness.id}
                    className="border-b last:border-b-0"
                    data-testid={`harness-row-${harness.slug}`}
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{harness.name}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {harness.slug}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={harness.status} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">v{harness.currentVersion}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {harness.nodeCount} nodes · {harness.edgeCount} edges
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                        <Link
                          href={`/dashboard/harnesses/${harness.id}/builder`}
                          data-testid={`open-builder-${harness.slug}`}
                        >
                          Open builder
                          <ChevronRight className="h-3 w-3" />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CreateAgentDialog({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState(MODEL_CHOICES[0]!.value);
  const [temperature, setTemperature] = useState("0.2");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const parsedTemperature = Number(temperature);
      const created = await api.post<{ agent: { id: string } }>("/api/agents", {
        projectId,
        name: name.trim(),
        description: description.trim() ? description.trim() : undefined,
        purpose: purpose.trim() ? purpose.trim() : undefined,
        instructions: instructions.trim(),
        modelConfig: {
          model,
          temperature: Number.isFinite(parsedTemperature) ? parsedTemperature : undefined,
        },
      });
      setOpen(false);
      router.push(`/dashboard/agents/${created.agent.id}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const canSubmit = name.trim() !== "" && instructions.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="create-agent">
          <Plus className="h-4 w-4" />
          New agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            The agent is the identity and base configuration. The harness controls behavior.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              data-testid="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Research Agent"
              required
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea
              id="agent-description"
              data-testid="agent-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Researches a topic and produces an evidence-backed answer."
              rows={2}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-purpose">Purpose</Label>
            <Input
              id="agent-purpose"
              data-testid="agent-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Perform structured research using external tools."
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-instructions">System instructions</Label>
            <Textarea
              id="agent-instructions"
              data-testid="agent-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="You are a rigorous research assistant…"
              rows={3}
              required
              maxLength={20000}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-model">Default model</Label>
              <select
                id="agent-model"
                data-testid="agent-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className={NATIVE_SELECT}
              >
                {MODEL_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-temperature">Temperature</Label>
              <Input
                id="agent-temperature"
                data-testid="agent-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </div>
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || !canSubmit} data-testid="agent-submit">
              {pending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateHarnessDialog({ agents }: { agents: AgentSummaryDto[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!agentId) {
      setError("Create an agent first — a harness always belongs to an agent.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const created = await api.post<{ harness: { id: string } }>(
        `/api/agents/${agentId}/harnesses`,
        {
          name: name.trim(),
          description: description.trim() ? description.trim() : undefined,
        },
      );
      setOpen(false);
      router.push(`/dashboard/harnesses/${created.harness.id}/builder`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Distinct testid: the project toolbar and the agent overview both
            offer "create harness", and both stay mounted across navigation. */}
        <Button
          variant="outline"
          disabled={agents.length === 0}
          data-testid="create-harness-project"
        >
          <Plus className="h-4 w-4" />
          New harness
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create harness</DialogTitle>
          <DialogDescription>
            Starts at v1 with a valid Start → End graph, ready for the visual builder.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="harness-agent">Agent</Label>
            <select
              id="harness-agent"
              data-testid="harness-agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className={NATIVE_SELECT}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="harness-name">Name</Label>
            <Input
              id="harness-name"
              data-testid="harness-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Research Harness"
              required
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="harness-description">Description</Label>
            <Textarea
              id="harness-description"
              data-testid="harness-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Structured research workflow with planning, search, critique and verification."
              rows={2}
              maxLength={500}
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={pending || name.trim() === ""}
              data-testid="harness-submit"
            >
              {pending ? "Creating…" : "Create harness"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
