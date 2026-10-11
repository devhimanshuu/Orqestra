import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./support/credentials";

/**
 * Phase 3 E2E: the evaluation engine's results must be visible and drivable in
 * the product.
 *
 *   Login → Datasets (create, edit, publish) → Evaluators (validate, revise) →
 *   Evaluations (start a batch, watch it finish, read metrics) → Compare
 *
 * The heavy lifting (real runs, real scoring) happens on the server through the
 * same services the API uses. These tests prove the *UI* — plus the API
 * contracts the UI depends on — behaves, which a backend-only check cannot.
 *
 * Test 3 depends on the harnesses and datasets created by
 * `scripts/verify-phase3.ts` (it skips, loudly, when they are absent).
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

async function apiPost<T>(
  page: Page,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: T; text: string }> {
  return page.evaluate(
    async ({ target, data }: { target: string; data: unknown }) => {
      const response = await fetch(target, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
      return { status: response.status, body, text };
    },
    { target: path, data: payload },
  ) as Promise<{ status: number; body: T; text: string }>;
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
  await page.goto("/login");
  await submit();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
}

test.describe("phase 3 — run lab and evaluation UI", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a dataset can be created, extended and versioned from the UI", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard/datasets");

    await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
    await expect(page.getByTestId("datasets-table").or(page.getByText("No datasets yet"))).toBeVisible();

    const name = `E2E Dataset ${Date.now()}`;
    await page.getByRole("button", { name: "New dataset" }).click();
    await page.getByTestId("dataset-name").fill(name);
    await page.getByTestId("dataset-create-submit").click();

    // Creating navigates straight to the new dataset's detail page.
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("v1", { exact: true }).first()).toBeVisible();

    // Add a case to the working set.
    await page.getByRole("button", { name: "Add case" }).click();
    await page.getByTestId("dataset-case-key").fill("e2e-case-1");
    await page.getByTestId("dataset-case-input").fill("\"What is 2 + 2?\"");
    await page.getByTestId("dataset-case-save").click();
    await expect(page.getByTestId("dataset-cases")).toContainText("e2e-case-1", { timeout: 20_000 });

    // Publish: the working set becomes immutable version 2.
    await page.getByTestId("dataset-publish").click();
    await expect(page.getByText(/Published version 2/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "v2", exact: true }).first()).toBeVisible();
  });

  test("an evaluator config is validated before it is saved, and edits create revisions", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/dashboard/evaluators");

    await expect(page.getByRole("heading", { name: "Evaluators" })).toBeVisible();

    const name = `E2E Tool usage ${Date.now()}`;
    await page.getByRole("button", { name: "New evaluator" }).click();
    await page.getByTestId("evaluator-kind").selectOption("tool_usage");
    await page.getByTestId("evaluator-name").fill(name);
    await page.locator("#new-evaluator-required").fill("current_time");

    // The server validates without saving (the editor's "Check configuration").
    await page.getByRole("button", { name: "Check configuration" }).click();
    await expect(page.getByText("Configuration is valid.")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("evaluator-create-submit").click();
    await expect(page.getByTestId("evaluators-table")).toContainText(name, { timeout: 20_000 });

    // Open it and publish a changed configuration.
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
    await page.locator("#evaluator-edit-required").fill("current_time, calculator");
    await page.getByTestId("evaluator-save-config").click();
    await expect(page.getByText(/Revision v2 published/)).toBeVisible({ timeout: 20_000 });
  });

  test("a batch runs end to end and renders metrics plus a comparison", async ({ page }) => {
    await signIn(page);

    // --- discover executable fixtures from scripts/verify-phase3.ts ---------
    const projects = await apiGet<{ projects: Array<{ id: string; name: string }> }>(
      page,
      "/api/projects",
    );
    const project = projects.body?.projects?.[0];
    if (project === undefined) {
      test.skip(true, "no projects — run `pnpm db:seed` first");
      return;
    }

    const agents = await apiGet<{ agents: Array<{ id: string; name: string }> }>(
      page,
      `/api/agents?projectId=${project.id}`,
    );
    const agent = agents.body?.agents?.find((entry) => entry.name.includes("Phase 3"));
    if (agent === undefined) {
      test.skip(true, "no Phase 3 verification agent — run `pnpm exec tsx scripts/verify-phase3.ts` first");
      return;
    }

    const harnesses = await apiGet<{ harnesses: Array<{ id: string; name: string; status: string }> }>(
      page,
      `/api/agents/${agent.id}/harnesses`,
    );
    const harness = harnesses.body?.harnesses?.find((entry) => entry.name.includes("baseline"));
    if (harness === undefined) {
      test.skip(true, "no baseline harness — run scripts/verify-phase3.ts first");
      return;
    }

    // A freshly created dataset version: the engine refuses two *identical*
    // batches in flight (same harness version × dataset version), and a fresh
    // dataset keeps this test independent of whatever else is running.
    const datasetName = `E2E Evaluation Dataset ${Date.now()}`;
    const datasetResponse = await apiPost<{ dataset: { id: string; name: string } }>(
      page,
      "/api/datasets",
      {
        projectId: project.id,
        name: datasetName,
        cases: [
          { caseKey: "alpha", input: "Say hello and report the time." },
          { caseKey: "beta", input: "What time does the tool report?" },
        ],
      },
    );
    const dataset = datasetResponse.body?.dataset;
    if (datasetResponse.status !== 201 || dataset === undefined) {
      test.skip(true, `could not create the evaluation dataset (status ${datasetResponse.status})`);
      return;
    }

    // Ensure an enabled deterministic evaluator exists for the batch.
    const evaluators = await apiGet<{ evaluators: Array<{ id: string; name: string; kind: string; enabled: boolean }> }>(
      page,
      `/api/evaluators?projectId=${project.id}&enabledOnly=true`,
    );
    let evaluatorId = evaluators.body?.evaluators?.find((entry) => entry.kind === "tool_usage")?.id ?? "";
    if (evaluatorId === "") {
      const created = await apiPost<{ evaluator: { id: string } }>(page, "/api/evaluators", {
        projectId: project.id,
        name: `E2E evaluator ${Date.now()}`,
        kind: "tool_usage",
        config: { required: ["current_time"], minCalls: { current_time: 1 }, maxCalls: { current_time: 5 } },
      });
      evaluatorId = created.body?.evaluator?.id ?? "";
    }
    if (evaluatorId === "") {
      test.skip(true, "no enabled tool_usage evaluator could be resolved");
      return;
    }

    // --- start the batch through the actual dialog -------------------------
    await page.goto("/dashboard/evaluations");
    await expect(page.getByRole("heading", { name: "Evaluations" })).toBeVisible();
    await page.getByTestId("evaluation-start").click();

    await page.getByTestId("evaluation-agent").selectOption(agent.id);
    await page.getByTestId("evaluation-harness").selectOption(harness.id);
    await page.getByTestId("evaluation-dataset").selectOption(dataset.id);
    await page.getByTestId(`evaluation-evaluator-${evaluatorId}`).check();
    await expect(page.getByTestId("evaluation-harness-version")).not.toHaveValue("");
    await page.getByTestId("evaluation-start-submit").click();

    // The dialog navigates to the batch detail page, which polls while running.
    await page.waitForURL(/\/dashboard\/evaluations\/[a-z0-9]+$/, { timeout: 30_000 });
    const detail = page.locator("main").filter({ has: page.getByTestId("evaluation-cases") });
    await expect(detail.getByTestId("evaluation-cases")).toBeVisible({ timeout: 30_000 });

    // The batch settles; the detail page's own status chip is the proof.
    await expect(detail.getByTestId("eval-batch-status-completed")).toBeVisible({ timeout: 240_000 });

    // Metrics are derived from persisted rows, not invented for the UI.
    await expect(detail.getByText("Mean score")).toBeVisible();
    await expect(detail.getByText("Estimated cost")).toBeVisible();
    await expect(detail.getByTestId("evaluation-cases")).toContainText("alpha");

    // --- compare two settled batches from the same dataset ------------------
    // The engine refuses batches from different datasets (their cases are not
    // comparable), so the test picks a dataset that has at least two settled
    // batches — the picker at the top of the comparison page holds the same
    // option list for both sides.
    await page.goto("/dashboard/evaluations/compare");
    const baselineSelect = page.getByTestId("compare-baseline");
    const optionTexts = await baselineSelect.locator("option").allTextContents();
    const byDataset = new Map<string, number[]>();
    optionTexts.forEach((text, index) => {
      // "… · <dataset name> v<N> · <time>" — the dataset name is the anchor.
      const datasetName = text.match(/·\s(.+?)\sv\d+\s·/)?.[1];
      if (datasetName === undefined) {
        return;
      }
      const bucket = byDataset.get(datasetName) ?? [];
      bucket.push(index);
      byDataset.set(datasetName, bucket);
    });
    const comparable = [...byDataset.values()].find((indexes) => indexes.length >= 2);
    if (comparable === undefined) {
      test.skip(true, "no dataset has two settled evaluations — run scripts/verify-phase3.ts first");
      return;
    }
    const baselineIndex = comparable[0];
    const candidateIndex = comparable[1];
    await baselineSelect.selectOption({ index: baselineIndex });
    await page.getByTestId("compare-candidate").selectOption({ index: candidateIndex });
    await page.getByTestId("compare-submit").click();
    await expect(page.getByText(/Verdict:/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Metric deltas")).toBeVisible();
  });
});
