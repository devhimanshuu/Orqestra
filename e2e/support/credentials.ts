/**
 * Demo credentials for e2e runs.
 *
 * `playwright.config.ts` loads `.env`, so the seed account and the tests can
 * never disagree about the password. The fallbacks match the env schema
 * defaults (src/config/env.ts).
 */
export const DEMO_EMAIL = process.env.SEED_USER_EMAIL ?? "demo@orqestra.dev";
export const DEMO_PASSWORD = process.env.SEED_USER_PASSWORD ?? "orqestra-demo-password";
