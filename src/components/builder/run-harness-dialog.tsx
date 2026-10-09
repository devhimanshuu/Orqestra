"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface RunPreviewResponse {
  ok: boolean;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  issues: Array<{ code: string; message: string; nodeId?: string }>;
  warnings: Array<{ code: string; message: string; nodeId?: string }>;
  stats: {
    nodeCount: number;
    edgeCount: number;
    estimatedLlmCalls: number;
    estimatedToolCalls: number;
    loopCount: number;
    maxIterations: number;
  } | null;
  estimate: string;
  harnessId: string;
  harnessVersionId: string | null;
  harnessVersionLabel: number | null;
  source: "version" | "draft";
  agentId: string | null;
  canRun: boolean;
  blockedReason: string | null;
}

interface CreateRunResponse {
  run: { id: string };
  dispatch: { mode: "queue" | "inline"; jobId: string | null };
}

/**
 * Run the harness.
 *
 * Step 1 shows what would happen (validation checks + an execution estimate) —
 * the same compile the runtime performs, so the preview cannot disagree with
 * execution. Step 2 creates the run and navigates to its detail page, where the
 * timeline streams live.
 *
 * Only published versions execute: the preview reports the exact version that a
 * click would run, and a draft-only harness explains what is missing.
 */
export function RunHarnessDialog({
  harnessId,
  disabled,
}: {
  harnessId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const previewQuery = useQuery({
    queryKey: ["harness", harnessId, "run-preview"],
    queryFn: () => api.get<RunPreviewResponse>(`/api/harnesses/${harnessId}/run-preview`),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const runMutation = useMutation({
    mutationFn: () => {
      const preview = previewQuery.data;
      if (preview === undefined || preview.harnessVersionId === null || preview.agentId === null) {
        throw new Error("This harness cannot be run yet");
      }
      return api.post<CreateRunResponse>("/api/runs", {
        agentId: preview.agentId,
        harnessVersionId: preview.harnessVersionId,
        input: input.trim(),
      });
    },
    onSuccess: (result) => {
      setOpen(false);
      router.push(`/dashboard/runs/${result.run.id}`);
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const preview = previewQuery.data;
  const canRun = preview?.canRun === true && input.trim() !== "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          data-testid="run-harness"
          disabled={disabled === true}
        >
          <Play className="h-3 w-3" />
          Run
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run harness</DialogTitle>
          <DialogDescription>
            The runtime executes the published version{" "}
            {preview?.harnessVersionLabel !== null && preview?.harnessVersionLabel !== undefined
              ? `v${preview.harnessVersionLabel}`
              : "of this harness"}{" "}
            as a queued job and traces every node.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border p-3" data-testid="run-preview">
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Execution preview
            </p>
            {previewQuery.isLoading ? (
              <p className="mt-2 text-xs text-muted-foreground">Compiling the harness…</p>
            ) : previewQuery.isError ? (
              <p className="mt-2 text-xs text-destructive">{errorMessage(previewQuery.error)}</p>
            ) : preview === undefined ? null : (
              <>
                <ul className="mt-2 flex flex-col gap-1">
                  {preview.checks.map((check) => (
                    <li key={check.label} className="flex items-start gap-2 text-xs">
                      {check.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                      )}
                      <span>
                        <span className="font-medium">{check.label}</span>
                        <span className="text-muted-foreground"> — {check.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 border-t pt-2 text-xs">
                  <span className="text-muted-foreground">Estimated execution: </span>
                  <span className="font-medium">{preview.estimate}</span>
                </p>
                {preview.warnings.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {preview.warnings.map((warning) => (
                      <li key={`${warning.code}-${warning.nodeId ?? ""}`} className="flex gap-2 text-[11px] text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preview.blockedReason !== null ? (
                  <p className="mt-2 text-[11px] font-medium text-destructive">{preview.blockedReason}</p>
                ) : null}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run-input">Task</Label>
            <Textarea
              id="run-input"
              data-testid="run-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={4}
              maxLength={20_000}
              placeholder="Research the benefits of TypeScript."
            />
            <p className="text-[10.5px] text-muted-foreground">
              The task becomes the START node&apos;s output and{" "}
              <code className="font-mono">{"{{ input }}"}</code> /{" "}
              <code className="font-mono">{"{{ state.task }}"}</code> in every node.
            </p>
          </div>

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            data-testid="run-submit"
            className={cn("gap-1.5")}
            disabled={!canRun || runMutation.isPending}
            onClick={() => runMutation.mutate()}
          >
            {runMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
