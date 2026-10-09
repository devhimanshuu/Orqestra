import { expect, test } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./support/credentials";

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

  test("seeded demo user can sign in and reach the projects dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(DEMO_EMAIL);
    await page.getByLabel("Password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
    await expect(page.getByText(DEMO_EMAIL)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  });
});
