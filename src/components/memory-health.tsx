"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface MemoryHealthResponse {
  redis: {
    status: "connected" | "disconnected" | "timeout";
    latencyMs: number | null;
    error: string | null;
    memory: Record<string, string> | null;
  };
  overall: string;
  checkedAt: string;
  checkDurationMs: number;
}

async function fetchMemoryHealth(): Promise<MemoryHealthResponse> {
  const response = await fetch("/api/memory-health", { cache: "no-store" });
  return (await response.json()) as MemoryHealthResponse;
}

function formatBytes(value: string | undefined): string {
  return value ?? "—";
}

/** Live Redis memory snapshot: usage, peak, fragmentation, and ping latency. */
export function MemoryHealth() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["memory-health"],
    queryFn: fetchMemoryHealth,
    refetchInterval: 15_000,
  });

  const connected = data?.redis.status === "connected";
  const memory = data?.redis.memory ?? null;

  return (
    <Card data-testid="memory-health">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-sm font-semibold">Redis memory</CardTitle>
            <CardDescription className="text-xs">
              Live memory usage and connection health.
            </CardDescription>
          </div>
          {data && (
            <Badge variant={connected ? "secondary" : "destructive"}>
              {data.redis.status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {isPending && <p className="text-muted-foreground">Checking Redis memory…</p>}
        {isError && (
          <p className="text-destructive">Could not reach /api/memory-health.</p>
        )}

        {data && !connected && (
          <p className="text-muted-foreground">
            {data.redis.error ?? "Redis is unreachable."}
          </p>
        )}

        {data && connected && (
          <>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Used memory</span>
              <span className="font-mono font-medium">
                {formatBytes(memory?.used_memory_human)}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Peak</span>
              <span className="font-mono font-medium">
                {formatBytes(memory?.used_memory_peak_human)}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Fragmentation</span>
              <span className="font-mono font-medium">
                {memory?.mem_fragmentation_ratio ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Keys</span>
              <span className="font-mono font-medium">
                {memory?.total_keys ?? memory?.keys ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">Ping latency</span>
              <span className="font-mono font-medium">
                {data.redis.latencyMs !== null ? `${data.redis.latencyMs} ms` : "—"}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
