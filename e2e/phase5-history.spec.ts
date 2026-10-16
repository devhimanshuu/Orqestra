import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./support/credentials";

/**
 * Optimization history — the one Phase 5 surface that spans sessions.
 *
 * A single session answers "did this candidate beat the baseline"; the history
 * answers "which mutation strategy tends to work, per weakness". That claim is
 * only defensible if every figure comes from stored rows, so these tests check
 * the page against the very API it renders from, and check the rule the view
 * exists to uphold: a value that was never measured is shown as unmeasured, not
 * as a zero.
 */

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
}

interface StrategyEffectivenessDto {
  strategy: string;
  evaluated: number;
  accepted: number;
  acceptanceRate: number | null;
  measured: number;
  metric: string | null;
  meanImprovement: number | null;
  meanRelativeImprovement: number | null;
}

interface CategoryEffectivenessDto {
  category: string;
  evaluated: number;
  acceptanceRate: number | null;
  measured: number;
  metric: string | null;
  meanImprovement: number | null;
  meanRelativeImprovement: number | null;
  evidence: "insufficient" | "suggestive" | "established";
  byStrategy: StrategyEffectivenessDto[];
  operations: Array<{ operation: string; candidates: number; accepted: number }>;
}

interface HistoryDto {
  totals: { sessions: number; candidates: number; measuredComparisons: number };
  categories: CategoryEffectivenessDto[];
  unattributed: { candidates: number } | null;
  notes: string[];
}

/** The view's own formatting, mirrored so the assertion is about the value. */
function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value: number | null): string {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** The view's raw-metric formatting: a mean in the metric's own units. */
function asMetric(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const magnitude = Math.abs(value);
  if (magnitude === 0) {
    return "0";
  }
  return magnitude >= 100 ? value.toFixed(1) : magnitude >= 1 ? value.toFixed(2) : value.toFixed(4);
}

test.describe("optimization history", () => {
  test("anonymous callers cannot read the history API", async ({ request }) => {
    const response = await request.get("/api/optimizations/history");
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  test("the list page links into the cross-session history", async ({ page }) => {
    await signIn(page);
    await page.goto("/dashboard/optimizations");
    await page.getByRole("link", { name: "Cross-session history" }).click();
    await expect(page).toHaveURL(/\/dashboard\/optimizations\/history$/);
    await expect(page.getByRole("heading", { name: "Optimization history" })).toBeVisible();
  });

  test("the page renders the aggregate the API returns, per category and strategy", async ({
    page,
  }) => {
    // A real page against a real database: allow for a cold render.
    test.setTimeout(60_000);
    await signIn(page);

    // Fetched through the page itself, so this is the request the dashboard's
    // own client code makes, carrying the session the browser actually holds.
    const payload = await page.evaluate(async () => {
      const response = await fetch("/api/optimizations/history", { credentials: "same-origin" });
      return { status: response.status, body: await response.json() };
    });
    expect(payload.status).toBe(200);
    const history = payload.body as HistoryDto;

    await page.goto("/dashboard/optimizations/history");
    await expect(page.getByRole("heading", { name: "Optimization history" })).toBeVisible();
    await expect(page.getByTestId("history-totals")).toBeVisible();

    // The read model states its own provenance, and the page shows all of it.
    expect(history.notes.length).toBeGreaterThan(0);
    await expect(page.getByTestId("history-note")).toHaveCount(history.notes.length);

    if (history.categories.length === 0) {
      await expect(page.getByTestId("history-empty")).toBeVisible();
      return;
    }

    await expect(page.getByTestId("history-empty")).toHaveCount(0);
    await expect(page.locator('[data-testid^="history-category-"]')).toHaveCount(
      history.categories.length,
    );

    for (const entry of history.categories) {
      const card = page.getByTestId(`history-category-${entry.category}`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId(`history-evidence-${entry.evidence}`)).toBeVisible();

      // Every strategy in the API's breakdown has a row of its own, carrying
      // that strategy's own rates — never the category's, never another's.
      await expect(card.locator('[data-testid^="history-strategy-"]')).toHaveCount(
        entry.byStrategy.length,
      );
      for (const strategy of entry.byStrategy) {
        const row = card.getByTestId(`history-strategy-${strategy.strategy}`);
        await expect(row).toBeVisible();
        const cells = row.locator("td");
        await expect(cells.nth(3)).toHaveText(String(strategy.evaluated));
        await expect(cells.nth(4)).toHaveText(String(strategy.accepted));
        // The honesty rule: a rate over nothing renders as unmeasured.
        expect(strategy.acceptanceRate === null).toBe(strategy.evaluated === 0);
        await expect(cells.nth(7)).toHaveText(percent(strategy.acceptanceRate));
        await expect(cells.nth(9)).toHaveText(signedPercent(strategy.meanRelativeImprovement));
        // The raw mean is shown in the metric's own units, and the unit is
        // named — a number in no unit would be unreadable.
        const meanCell = (await cells.nth(8).textContent()) ?? "";
        expect(meanCell.startsWith(asMetric(strategy.meanImprovement))).toBe(true);
        if (strategy.measured > 0) {
          expect(meanCell).toMatch(/\/\s*\S/);
        }
      }

      // Mutations that were actually tried are listed with their own outcomes.
      for (const operation of entry.operations) {
        await expect(card.getByText(operation.operation, { exact: true })).toBeVisible();
      }

      // The category's own headline figures agree with the API.
      await expect(card.getByText(percent(entry.acceptanceRate), { exact: true }).first()).toBeVisible();
      if (entry.measured > 0) {
        await expect(
          card.getByText(signedPercent(entry.meanRelativeImprovement), { exact: true }).first(),
        ).toBeVisible();
      }
    }

    if (history.unattributed !== null && history.unattributed.candidates > 0) {
      await expect(page.getByTestId("history-unattributed")).toBeVisible();
    }
  });
});
