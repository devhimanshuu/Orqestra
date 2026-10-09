import { loadEnvFile } from "node:process";
import { defineConfig, devices } from "@playwright/test";

// Load the same .env the application uses, so tests and the server under test
// agree on the seeded credentials, the database, and the auth provider.
try {
  loadEnvFile();
} catch {
  // No .env file — tests fall back to the documented defaults.
}

const PORT = 3100;
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/** process.env with undefined values dropped (webServer env requires strings). */
const serverEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // Every page read goes to a remote (Neon) database and sessions are resolved
  // against the hosted auth instance, so assertions need more room than the
  // 5s default — cold starts alone can take seconds.
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Next 16 allows only one `next dev` per project directory, so e2e runs
  // against a production build instead: self-contained and representative.
  //
  // APP_URL is intentionally *not* overridden here: it is the canonical origin
  // registered with the hosted auth instance, which is what the Neon Auth
  // proxy presents on forwarded requests. Requests from this dev origin are
  // accepted because they are same-origin for the app itself.
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: serverEnv,
  },
});
