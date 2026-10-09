"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronRight, Copy, Network, Pencil, Plus } from "lucide-react";
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

export interface AgentOverviewDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  latestVersion: {
    version: number;
    purpose: string | null;
    instructions: string;
    modelConfig: { model: string; temperature?: number; maxTokens?: number };
  };
  harnesses: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    currentVersion: number;
    nodeCount: number;
  }>;
  runCount: number;
  versionCount: number;
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
 * Agent overview: identity + stats + harnesses. Execution is deliberately
 * absent — the runtime arrives in Phase 2.
 */
export function AgentOverviewView({ agent }: { agent: AgentOverviewDto }) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <p className="text-sm text-muted-foreground">
            {agent.description ?? "No description yet."}
          </p>
          {agent.latestVersion.purpose ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Purpose:</span>{" "}
              {agent.latestVersion.purpose}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <EditAgentDialog agent={agent} />
          <CreateHarnessDialog agentId={agent.id} />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-4" data-testid="agent-stats">
        <StatCard label="Model" value={agent.latestVersion.modelConfig.model} mono />
        <StatCard
          label="Temperature"
          value={
            agent.latestVersion.modelConfig.temperature !== undefined
              ? String(agent.latestVersion.modelConfig.temperature)
              : "—"
          }
        />
        <StatCard label="Agent version" value={`v${agent.latestVersion.version}`} mono />
        <StatCard label="Runs" value={String(agent.runCount)} hint="Execution arrives in Phase 2" />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Harnesses</h2>
            <p className="text-sm text-muted-foreground">
              {agent.harnesses.length} harness{agent.harnesses.length === 1 ? "" : "es"} ·{" "}
              {agent.versionCount} agent version{agent.versionCount === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {agent.harnesses.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No harness yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Build this agent&apos;s behavior visually.
              </p>
            </div>
            <CreateHarnessDialog agentId={agent.id} testId="create-harness-empty" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border" data-testid="harness-list">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Harness</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Nodes</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {agent.harnesses.map((harness) => (
                  <HarnessRow key={harness.id} harness={harness} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 truncate text-sm font-semibold ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-[10.5px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function HarnessRow({ harness }: { harness: AgentOverviewDto["harnesses"][number] }) {
  const router = useRouter();
  const [duplicating, setDuplicating] = useState(false);

  async function handleDuplicate(): Promise<void> {
    setDuplicating(true);
    try {
      const created = await api.post<{ harness: { id: string } }>(
        `/api/harnesses/${harness.id}/duplicate`,
        {},
      );
      router.push(`/dashboard/harnesses/${created.harness.id}/builder`);
      router.refresh();
    } finally {
      setDuplicating(false);
    }
  }

  return (
    <tr className="border-b last:border-b-0" data-testid={`harness-row-${harness.slug}`}>
      <td className="px-4 py-2.5">
        <span className="font-medium">{harness.name}</span>
        <span className="ml-2 font-mono text-[10px] text-muted-foreground">{harness.slug}</span>
      </td>
      <td className="px-4 py-2.5">
        <StatusBadge status={harness.status} />
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">v{harness.currentVersion}</td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground">{harness.nodeCount}</td>
      <td className="px-4 py-2.5">
        <div className="flex justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={duplicating}
            title="Duplicate harness"
            data-testid={`duplicate-harness-${harness.slug}`}
            onClick={() => void handleDuplicate()}
          >
            <Copy className="h-3 w-3" />
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            <Link
              href={`/dashboard/harnesses/${harness.id}/builder`}
              data-testid={`open-builder-${harness.slug}`}
            >
              Open builder
              <ChevronRight className="h-3 w-3" />
            </Link>
          </Button>
        </div>
      </td>
    </tr>
  );
}

function EditAgentDialog({ agent }: { agent: AgentOverviewDto }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [purpose, setPurpose] = useState(agent.latestVersion.purpose ?? "");
  const [instructions, setInstructions] = useState(agent.latestVersion.instructions);
  const [model, setModel] = useState(agent.latestVersion.modelConfig.model);
  const [temperature, setTemperature] = useState(
    agent.latestVersion.modelConfig.temperature !== undefined
      ? String(agent.latestVersion.modelConfig.temperature)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const parsedTemperature = Number(temperature);
      await api.patch(`/api/agents/${agent.id}`, {
        name: name.trim(),
        description: description.trim(),
        purpose: purpose.trim() ? purpose.trim() : undefined,
        instructions: instructions.trim(),
        modelConfig: {
          model,
          temperature:
            temperature.trim() !== "" && Number.isFinite(parsedTemperature)
              ? parsedTemperature
              : undefined,
        },
      });
      setOpen(false);
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
        <Button variant="outline" data-testid="edit-agent">
          <Pencil className="h-3.5 w-3.5" />
          Edit agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>
            Saving creates a new immutable agent version (v{agent.latestVersion.version + 1}).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-name">Name</Label>
            <Input
              id="edit-agent-name"
              data-testid="edit-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-description">Description</Label>
            <Textarea
              id="edit-agent-description"
              data-testid="edit-agent-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-purpose">Purpose</Label>
            <Input
              id="edit-agent-purpose"
              data-testid="edit-agent-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-instructions">System instructions</Label>
            <Textarea
              id="edit-agent-instructions"
              data-testid="edit-agent-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={4}
              required
              maxLength={20000}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-agent-model">Model</Label>
              <select
                id="edit-agent-model"
                data-testid="edit-agent-model"
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
              <Label htmlFor="edit-agent-temperature">Temperature</Label>
              <Input
                id="edit-agent-temperature"
                data-testid="edit-agent-temperature"
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
            <Button
              type="submit"
              disabled={pending || name.trim() === "" || instructions.trim() === ""}
              data-testid="edit-agent-submit"
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateHarnessDialog({
  agentId,
  testId = "create-harness",
}: {
  agentId: string;
  testId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
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
        <Button data-testid={testId}>
          <Plus className="h-4 w-4" />
          Create harness
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
            <Label htmlFor="new-harness-name">Name</Label>
            <Input
              id="new-harness-name"
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
            <Label htmlFor="new-harness-description">Description</Label>
            <Textarea
              id="new-harness-description"
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
