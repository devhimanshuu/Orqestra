/**
 * Health DTO — shared between the health service (server) and the dashboard UI
 * (client). Lives in src/types so client components never import server-only
 * modules just to get a type.
 */

export type ServiceStatus = "healthy" | "unhealthy";

export type HealthReportStatus = "healthy" | "degraded";

export type HealthServiceKey = "application" | "environment" | "database" | "redis";

export interface HealthReport {
  status: HealthReportStatus;
  timestamp: string;
  services: Record<HealthServiceKey, ServiceStatus>;
  latencyMs: {
    database: number | null;
    redis: number | null;
  };
  /** Present only for failed checks: variable names or error messages — never values. */
  errors: Partial<Record<HealthServiceKey, string>>;
}
