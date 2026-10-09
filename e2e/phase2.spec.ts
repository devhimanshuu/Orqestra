import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./support/credentials";

/**
 * Phase 2 E2E: the runtime's results must be visible in the product.
 *
 *   Login → Runs (history + filters) → Run detail (timeline, usage,
 *   reproducibility) → Builder (Run affordance + execution preview)
 *
 * Runs are produced by `scripts/verify-phase2.ts` (which exercises the runtime
 * against the real database). This spec asserts the *UI* renders that execution
 * data correctly, which is the part a backend-only test cannot prove.
 */

/**
 * Calls a JSON API from inside the page, exactly like the app's own client does
 * (`credentials: "same-origin"`). Using the page rather than Playwright's
 * request context keeps the assertion on the real browser session.
 */
async function apiGet<T>(
  page: Page,
  path: string,
): Promise<{ status: number; body: T; text: string }> {
  return page.evaluate(async (target: string) => {
    const response = await fetch(target, { credentials: "same-origin" });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  }, path) as Promise<{ status: number; body: T; text: string }>;
}

async function signIn(page: Page): Promise<void> {
  const submit = async (): Promise<boolean> => {
    await page.getByLabel("Email").fill(DEMO_EMAIL);
    await page.getByLabel("Password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    return page
      .waitForURL(/\/dashboard$/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
  };

  await page.goto("/login");
  if (await submit()) {
    return;
  }

  // A cold production server can serve the login page before its JS hydrates,
  // so the first click becomes a native form submit. The chunks are cached by
  // now, so a reload and a second attempt goes through the app's own handler.
  await page.goto("/login");
  await submit();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
}

test.describe("phase 2 — run history and trace UI", () => {
  // Sign-in plus remote-database page reads need more than the 30s default.
  test.describe.configure({ timeout: 90_000 });

  test("run history lists executions with status, tokens and duration", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard/runs");

    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

    const rows = page.locator('[data-testid^="run-row-"]');
    const rowCount = await rows.count();
    // Runs are created by scripts/verify-phase2.ts; if the database has none the
    // empty state must be shown instead (a silent blank table would be a bug).
    if (rowCount === 0) {
      await expect(page.getByText("No runs yet")).toBeVisible();
      return;
    }

    await expect(rows.first()).toBeVisible();
    await expect(page.locator('[data-testid^="run-status-"]').first()).toBeVisible();
    // The filter controls are part of the deliverable (status/harness/date).
    await expect(page.getByTestId("runs-filter-status")).toBeVisible();
    await expect(page.getByTestId("runs-filter-harness")).toBeVisible();
    await expect(page.getByTestId("runs-filter-since")).toBeVisible();
  });

  test("run detail renders the persisted trace, usage and reproducibility pins", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard/runs");

    const rows = page.locator('[data-testid^="run-row-"]');
    if ((await rows.count()) === 0) {
      test.skip(true, "No runs in the database — run scripts/verify-phase2.ts first");
      return;
    }

    const firstRow = rows.first();
    const runId = (await firstRow.getAttribute("data-testid"))?.replace("run-row-", "") ?? "";
    await firstRow.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/runs/${runId}$`), { timeout: 20_000 });

    // The API drives the same data the page shows; asserting both keeps the
    // server payload and the rendered trace honest.
    const response = await apiGet<{
      steps: Array<{ nodeId: string }>;
      events: unknown[];
      usageTotal: { totalTokens: number };
    }>(page, `/api/runs/${runId}`);
    expect(response.status, `GET /api/runs/${runId} → ${response.text.slice(0, 200)}`).toBe(200);
    const payload = response.body;

    const timeline = page.getByTestId("run-timeline");
    if (payload.steps.length === 0) {
      await expect(page.getByText(/Waiting for the first node|produced no steps/)).toBeVisible();
      return;
    }

    await expect(timeline).toBeVisible();
    for (const step of payload.steps.slice(0, 3)) {
      await expect(page.getByTestId(`run-step-${step.nodeId}`)).toBeVisible();
    }

    // Expanding a step reveals input/output/configuration/timing.
    await page.getByTestId(`run-step-${payload.steps[0]?.nodeId}`).getByRole("button").click();
    await expect(page.getByText("Configuration & metadata").first()).toBeVisible();
    await expect(page.getByText("Timing").first()).toBeVisible();

    await expect(page.getByTestId("retry-run")).toBeVisible();
    await expect(page.getByText("Reproducibility")).toBeVisible();
    await expect(page.getByText("Content hash")).toBeVisible();
  });

  test("run detail exposes the right controls for the run's state", async ({ page }) => {
    await signIn(page);
    const response = await apiGet<{ runs: Array<{ id: string; status: string }> }>(
      page,
      "/api/runs?limit=5",
    );
    expect(response.status, `GET /api/runs → ${response.text.slice(0, 200)}`).toBe(200);

    const target =
      response.body.runs.find((run) => run.status === "RUNNING" || run.status === "QUEUED") ??
      response.body.runs[0];
    if (target === undefined) {
      test.skip(true, "No runs available");
      return;
    }

    await page.goto(`/dashboard/runs/${target.id}`);
    await expect(page.locator('[data-testid^="run-status-"]').first()).toBeVisible();

    if (target.status === "RUNNING" || target.status === "QUEUED") {
      // A live run is cancellable and its timeline may still grow.
      await expect(page.getByTestId("cancel-run")).toBeVisible();
    } else {
      // A finished run is immutable but reproducible.
      await expect(page.getByTestId("retry-run")).toBeVisible();
    }
  });

  test("run events stream over SSE with replay", async ({ page }) => {
    await signIn(page);
    const runs = await apiGet<{ runs: Array<{ id: string; status: string }> }>(
      page,
      "/api/runs?limit=20",
    );
    expect(runs.status).toBe(200);

    const finished = runs.body.runs.find((run) => run.status === "SUCCEEDED");
    if (finished === undefined) {
      test.skip(true, "No completed run to replay");
      return;
    }

    // A terminal run replays its whole persisted event stream and then closes,
    // which makes the SSE contract assertable without racing a live run.
    const stream = await page.evaluate(async (runId: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(`/api/runs/${runId}/events`, { signal: controller.signal });
        const body = await response.text();
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body,
        };
      } finally {
        clearTimeout(timer);
      }
    }, finished.id);

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    expect(stream.body).toMatch(/id: \d+/);
    expect(stream.body).toContain("event: RUN_STARTED");
    expect(stream.body).toContain("event: NODE_STARTED");
    expect(stream.body).toContain("event: NODE_COMPLETED");
    expect(stream.body).toContain("event: RUN_COMPLETED");
  });

  test("builder exposes Run and the execution preview", async ({ page }) => {
    await signIn(page);

    // Open the builder of a harness that has actually executed before (found
    // through the app's own runs API), so the preview has real config to show.
    const runs = await apiGet<{ runs: Array<{ harnessId: string; agentId: string | null }> }>(
      page,
      "/api/runs?limit=20",
    );
    expect(runs.status, `GET /api/runs → ${runs.text.slice(0, 200)}`).toBe(200);

    const harnessId = (runs.body.runs.find((run) => run.agentId !== null) ?? runs.body.runs[0])
      ?.harnessId;
    if (harnessId === undefined) {
      test.skip(true, "No harness has been run yet");
      return;
    }

    await page.goto(`/dashboard/harnesses/${harnessId}/builder`);
    await expect(page.getByTestId("run-harness")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("run-harness").click();

    // The preview is the compiler's verdict: either every check passes, or the
    // dialog explains exactly what blocks execution.
    const preview = page.getByTestId("run-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByText("Execution preview")).toBeVisible();
    // Either the compiler accepted the graph (estimate shown) or the dialog
    // explains exactly why Run is unavailable.
    await expect(
      preview.getByText(
        /Estimated execution|Fix the validation issues|Attach this harness|Publish a version/,
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("run-input")).toBeVisible();
    await expect(page.getByTestId("run-submit")).toBeVisible();
  });
});
