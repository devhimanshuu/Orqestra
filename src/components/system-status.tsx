"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { HealthReport, HealthServiceKey } from "@/types/health";

const SERVICE_LABELS: Record<HealthServiceKey, string> = {
  application: "Application",
  environment: "Environment",
  database: "Database",
  redis: "Redis",
};

async function fetchHealth(): Promise<HealthReport> {
  const response = await fetch("/api/health", { cache: "no-store" });
  // The endpoint returns a structured body for both 200 and 503.
  return (await response.json()) as HealthReport;
}

/** Presentation-only component: TanStack Query owns the server state. */
export function SystemStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["system-health"],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>System status</CardTitle>
            <CardDescription>
              Live checks against PostgreSQL, Redis, and the environment.
            </CardDescription>
          </div>
          {data && (
            <Badge variant={data.status === "healthy" ? "secondary" : "destructive"}>
              {data.status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isPending && <p className="text-sm text-muted-foreground">Checking dependencies…</p>}
        {isError && (
          <p className="text-sm text-destructive">
            Could not reach /api/health — is the server running?
          </p>
        )}

        {data && (
          <ul className="flex flex-col gap-3">
            {(Object.keys(SERVICE_LABELS) as HealthServiceKey[]).map((key, index) => {
              const healthy = data.services[key] === "healthy";
              return (
                <li key={key}>
                  {index > 0 && <Separator className="mb-3" />}
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        aria-hidden
                        className={healthy ? "text-emerald-600" : "text-destructive"}
                      >
                        {healthy ? "✓" : "✗"}
                      </span>
                      {SERVICE_LABELS[key]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {key === "database" || key === "redis"
                        ? data.latencyMs[key] !== null
                          ? `${data.latencyMs[key]} ms`
                          : "unavailable"
                        : (data.errors[key] ?? "ok")}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
