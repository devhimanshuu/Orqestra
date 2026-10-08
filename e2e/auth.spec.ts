import { expect, test } from "@playwright/test";

/**
 * Phase 0 integration smoke: Next.js → Authentication → Database → Redis → API.
 *
 * Prerequisites (see README): `docker compose up -d`, `pnpm db:migrate`,
 * `pnpm db:seed`. The seeded demo user is used for sign-in.
 */
test.describe("authentication", () => {
  test("anonymous visitors are redirected to the login page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("seeded demo user can sign in and see the system status", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("demo@orqestra.dev");
    await page.getByLabel("Password").fill("orqestra-demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
    await expect(page.getByText("demo@orqestra.dev")).toBeVisible();
    await expect(page.getByText("System status")).toBeVisible();
  });
});
