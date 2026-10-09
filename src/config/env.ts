import { z } from "zod";

/**
 * Environment schema.
 *
 * Classification (mirrored in .env.example):
 *  - required:            DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET
 *  - optional:            APP_URL, LOG_LEVEL
 *  - provider-specific:   GEMINI/GROQ/OPENAI/ANTHROPIC keys, OLLAMA_BASE_URL
 *  - development-only:    SEED_*
 *
 * The application validates this schema once at startup (see
 * src/instrumentation.ts) and fails fast with an explicit list of problems.
 * Values are never echoed back in error messages, so secrets cannot leak
 * through logs.
 */

const isPostgresUrl = (value: string): boolean => /^postgres(ql)?:\/\/\S+$/.test(value);
const isRedisUrl = (value: string): boolean => /^(redis|rediss|unix):\/\/\S+$/.test(value);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- required -------------------------------------------------------------
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required")
    .refine(isPostgresUrl, "DATABASE_URL must be a postgresql:// connection string"),
  REDIS_URL: z
    .string({ error: "REDIS_URL is required" })
    .min(1, "REDIS_URL is required")
    .refine(isRedisUrl, "REDIS_URL must be a redis:// (or rediss://) connection string"),
  BETTER_AUTH_SECRET: z
    .string({ error: "BETTER_AUTH_SECRET is required" })
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),

  // --- Neon Auth (hosted Better Auth) --------------------------------------
  // When AUTH_URL is set, /api/auth/* is proxied to Neon's hosted Better Auth
  // and sessions are resolved against it (see src/lib/auth/neon-auth.provider.ts).
  // JWKS_URL exposes the instance's EdDSA keys for future stateless JWT checks.
  AUTH_URL: z.url().default(""),
  JWKS_URL: z.url().default(""),

  // --- optional application settings ---------------------------------------
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- runtime execution ----------------------------------------------------
  // auto: enqueue through BullMQ when Redis answers, otherwise execute inline
  // (development without Redis, single-process deployments). queue: BullMQ only.
  // inline: never touch the queue — useful for tests and local runs.
  RUN_EXECUTION_MODE: z.enum(["auto", "queue", "inline"]).default("auto"),
  /** Wall-clock ceiling for a single run. */
  RUNTIME_MAX_DURATION_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  /** Hard ceilings that guard the platform, independent of per-run requests. */
  RUNTIME_MAX_NODES: z.coerce.number().int().min(1).max(10_000).default(100),
  RUNTIME_MAX_ITERATIONS: z.coerce.number().int().min(1).max(1_000).default(10),
  RUNTIME_MAX_LLM_CALLS: z.coerce.number().int().min(1).max(10_000).default(30),
  RUNTIME_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Comma-separated extra origins allowed to call the auth API (wildcards supported). */
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(""),

  // --- optional, provider-specific -----------------------------------------
  GEMINI_API_KEY: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),

  // --- development-only (seeding) -------------------------------------------
  SEED_USER_EMAIL: z.email().default("demo@orqestra.dev"),
  SEED_USER_PASSWORD: z.string().min(8).default("orqestra-demo-password"),
});

export type Env = z.infer<typeof envSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(
      [
        "Invalid environment configuration — the application cannot start.",
        ...issues.map((issue) => `  - ${issue}`),
        "See .env.example for the full list of supported variables.",
      ].join("\n"),
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

/** Strips surrounding single or double quotes that .env files may contain. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Validate a raw environment object. Throws EnvironmentValidationError on failure. */
export function validateEnv(raw: unknown): Env {
  // Next.js loads .env files but does not strip quotes from values.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    cleaned[key] = typeof value === "string" ? unquote(value) : value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvironmentValidationError(issues);
  }
  return result.data;
}

let cachedEnv: Env | null = null;

/** Process-wide env accessor. Validated once, then memoized. */
export function getEnv(): Env {
  if (cachedEnv === null) {
    cachedEnv = validateEnv(process.env);
  }
  return cachedEnv;
}

/** Test helper: drop the memoized env so the next getEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cachedEnv = null;
}
