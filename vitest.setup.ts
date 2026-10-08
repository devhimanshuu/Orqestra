/**
 * Unit-test environment defaults.
 *
 * The app validates env at startup; unit tests exercise modules that read the
 * validated env, so provide deterministic, credential-free defaults here.
 */

process.env.DATABASE_URL ??= "postgresql://orqestra:orqestra@localhost:5432/orqestra?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.BETTER_AUTH_SECRET ??= "unit-test-secret-value-long-enough-0123456789";
// Deterministic: provider credentials are absent in unit tests.
process.env.GEMINI_API_KEY = "";
process.env.LOG_LEVEL = "error";
