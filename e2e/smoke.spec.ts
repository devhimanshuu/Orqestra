import { expect, test } from "@playwright/test";

test.describe("Phase 0 smoke", () => {
  test("application loads", async ({ page }) => {
    await page.goto("/");
    // The marketing landing page: its wordmark names the product, the display
    // headline states what it is, and both calls to action lead into the app.
    await expect(page.getByRole("link", { name: "orqestra" }).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /harness engineering infrastructure/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Start building" }).first()).toBeVisible();
  });

  test("login page renders the credential form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("health endpoint returns a structured report", async ({ request }) => {
    const response = await request.get("/api/health");
    // 200 when every dependency is healthy, 503 when degraded — both are valid.
    expect([200, 503]).toContain(response.status());

    const body = (await response.json()) as {
      status: string;
      services: Record<string, string>;
    };
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(Object.keys(body.services)).toEqual(
      expect.arrayContaining(["application", "environment", "database", "redis"]),
    );
  });
});
