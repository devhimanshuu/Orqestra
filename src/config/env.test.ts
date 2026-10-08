import { describe, expect, it } from "vitest";
import { EnvironmentValidationError, envSchema, validateEnv } from "./env";

const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db?schema=public",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "a-very-long-development-secret-value-123456",
  APP_URL: "http://localhost:3000",
  OLLAMA_BASE_URL: "http://localhost:11434",
};

describe("validateEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = validateEnv(validEnv);
    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.GEMINI_API_KEY).toBe("");
    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434");
  });

  it("fails with an explicit message when required variables are missing", () => {
    expect(() => validateEnv({})).toThrow(EnvironmentValidationError);

    try {
      validateEnv({});
      expect.unreachable("validateEnv should have thrown");
    } catch (error) {
      const validationError = error as EnvironmentValidationError;
      const joined = validationError.issues.join("\n");
      expect(joined).toContain("DATABASE_URL");
      expect(joined).toContain("REDIS_URL");
      expect(joined).toContain("BETTER_AUTH_SECRET");
    }
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const result = envSchema.safeParse({ ...validEnv, DATABASE_URL: "mysql://localhost/db" });
    expect(result.success).toBe(false);
  });

  it("rejects a secret that is too short", () => {
    const result = envSchema.safeParse({ ...validEnv, BETTER_AUTH_SECRET: "short" });
    expect(result.success).toBe(false);
  });

  it("never echoes values in the error message", () => {
    const secret = "leaky-secret-value-that-should-not-appear-1234";
    try {
      validateEnv({ ...validEnv, DATABASE_URL: secret });
      expect.unreachable("validateEnv should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
