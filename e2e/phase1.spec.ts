import { expect, test, type Page } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "./support/credentials";

/**
 * Phase 1's most important E2E test — the full product loop:
 *
 *   Login → Create Project → Create Agent → Create Harness → Open Builder →
 *   Add nodes → Connect nodes → Configure node → Validate → Save →
 *   Create version → Reload → Verify graph persists → Verify v1 immutable.
 *
 * Runs against a production build (see playwright.config.ts) with the real
 * database and auth. Uses unique names per run so reruns never collide.
 */

const RUN_ID = Date.now().toString(36);
const PROJECT_NAME = `E2E Project ${RUN_ID}`;
const AGENT_NAME = `E2E Agent ${RUN_ID}`;
const HARNESS_NAME = `E2E Harness ${RUN_ID}`;

/** Signs in with the seeded demo account, falling back to a fresh sign-up. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  const arrived = await page
    .waitForURL(/\/dashboard$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (arrived) {
    return;
  }

  // Demo credentials did not work on this deployment — create a throwaway account.
  await page.getByRole("button", { name: /Sign up/ }).click();
  await page.getByLabel("Name").fill("E2E Runner");
  await page.getByLabel("Email").fill(`e2e-${RUN_ID}@orqestra.dev`);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
}

/**
 * Waits for a client-side transition to settle.
 *
 * Next 16 keeps the previous route's tree mounted for a moment after a
 * transition, so a locator can match elements from both pages — wait until only
 * the new canvas remains before asserting on names or counts.
 */
async function waitForCanvasSettle(page: Page): Promise<void> {
  await expect(page.locator(".react-flow__pane").last()).toBeVisible();
}

/**
 * The live builder tree. The outgoing page stays in the DOM (hidden) for a
 * moment after a transition, so every builder assertion filters to what the
 * user actually sees instead of matching both trees.
 */
function visibleTestId(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true });
}

function builderName(page: Page) {
  return visibleTestId(page, "builder-harness-name");
}

function canvasNodes(page: Page) {
  return page.locator(".react-flow__node").filter({ visible: true });
}

function canvasEdges(page: Page) {
  return page.locator(".react-flow__edge").filter({ visible: true });
}

/** Fit the whole graph into the viewport so every handle is on screen. */
async function fitView(page: Page): Promise<void> {
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(150);
}

/**
 * Drag a connection from one node's output handle to another's input handle and
 * assert the edge count grew — a dropped connection is a product bug worth a
 * precise failure rather than a count mismatch three steps later.
 */
async function connectNodes(
  page: Page,
  sourceTestid: string,
  targetTestid: string,
  expectedEdges: number,
): Promise<void> {
  await fitView(page);
  const source = page.locator(`[data-testid="${sourceTestid}"] .react-flow__handle.source`).first();
  const target = page.locator(`[data-testid="${targetTestid}"] .react-flow__handle.target`).first();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) {
    throw new Error(`Could not locate handles for ${sourceTestid} → ${targetTestid}`);
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Two intermediate moves keep the connection line attached in React Flow.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
}

test.describe("Phase 1: agent & visual harness builder", () => {
  test.setTimeout(180_000);

  test("full flow: project → agent → harness → build → validate → version → reload", async ({
    page,
  }) => {
    await signIn(page);

    // ── Create project ────────────────────────────────────────────────────
    await page.getByTestId("create-project").click();
    await page.getByTestId("project-name").fill(PROJECT_NAME);
    await page.getByTestId("project-description").fill("Created by the Phase 1 e2e test.");
    await page.getByTestId("project-submit").click();
    await page.getByText(PROJECT_NAME).click();
    await expect(page).toHaveURL(/\/dashboard\/projects\//);

    // ── Create agent ──────────────────────────────────────────────────────
    await page.getByTestId("create-agent").click();
    await page.getByTestId("agent-name").fill(AGENT_NAME);
    await page.getByTestId("agent-description").fill("End-to-end test agent.");
    await page.getByTestId("agent-purpose").fill("Verify the Phase 1 product loop.");
    await page
      .getByTestId("agent-instructions")
      .fill("You are a test agent. Answer concisely and cite evidence.");
    await page.getByTestId("agent-temperature").fill("0.2");
    await page.getByTestId("agent-submit").click();
    await expect(page).toHaveURL(/\/dashboard\/agents\//, { timeout: 20_000 });
    // The overview streams behind a Suspense boundary and every read hits the
    // remote database, so allow for cold-start latency.
    await expect(page.getByRole("heading", { name: AGENT_NAME })).toBeVisible({ timeout: 30_000 });

    // ── Create harness (auto v1) → builder ────────────────────────────────
    await page.getByTestId("create-harness").click();
    await page.getByTestId("harness-name").fill(HARNESS_NAME);
    await page.getByTestId("harness-description").fill("Planning, review and verification loop.");
    await page.getByTestId("harness-submit").click();
    await expect(page).toHaveURL(/\/builder$/, { timeout: 20_000 });
    await expect(page.getByTestId("builder-harness-name")).toHaveText(HARNESS_NAME);
    await expect(page.getByTestId("node-start")).toBeVisible();
    await expect(page.getByTestId("node-end")).toBeVisible();

    // ── Add nodes from the library ────────────────────────────────────────
    await page.getByTestId("node-library-item-planner").click();
    await expect(page.getByTestId("node-planner")).toBeVisible();
    await page.getByTestId("node-library-item-critic").click();
    await expect(page.getByTestId("node-critic")).toBeVisible();

    // ── Connect: start → planner → critic → end ───────────────────────────
    // The created harness already ships start → end, so the counts are 2, 3, 4.
    await connectNodes(page, "node-start", "node-planner", 2);
    await connectNodes(page, "node-planner", "node-critic", 3);
    await connectNodes(page, "node-critic", "node-end", 4);

    // ── Configure a node through the inspector ────────────────────────────
    await page.getByTestId("node-planner").click();
    const instructions = page.getByTestId("inspector-field-instructions");
    await instructions.fill("Break the research question into verifiable steps.");
    await instructions.blur();
    const maxSteps = page.getByTestId("inspector-field-maxSteps");
    await maxSteps.fill("5");
    await maxSteps.blur();

    // ── Validate (client rules + server confirmation) ─────────────────────
    await page.getByTestId("builder-tab-validation").click();
    await page.getByTestId("validate-button").click();
    await expect(page.getByTestId("validation-summary")).toHaveText("Harness is valid", {
      timeout: 15_000,
    });

    // ── Autosave settles (drafts only — never a version) ──────────────────
    await expect(page.getByTestId("save-status")).toContainText("Saved", { timeout: 20_000 });

    // ── Publish an immutable version ──────────────────────────────────────
    await page.getByTestId("builder-tab-versions").click();
    await expect(page.getByTestId("version-item-1")).toBeVisible();
    await page
      .getByTestId("publish-release-notes")
      .fill("Added planner and critic between start and end.");
    await page.getByTestId("publish-version").click();
    await expect(page.getByTestId("versions-notice")).toContainText("Version v2 created", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("version-item-2")).toBeVisible();
    // v1 stays exactly as created: the default start → end graph.
    await expect(page.getByTestId("version-item-1")).toContainText("2 nodes");

    // ── Reload: the draft graph must come back identical ─────────────────
    await page.reload();
    await expect(page.getByTestId("node-start")).toBeVisible();
    await expect(page.getByTestId("node-planner")).toBeVisible();
    await expect(page.getByTestId("node-critic")).toBeVisible();
    await expect(page.getByTestId("node-end")).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(4, { timeout: 10_000 });

    // Configuration survived the round-trip through the database.
    await page.getByTestId("node-planner").click();
    await expect(page.getByTestId("inspector-field-instructions")).toHaveValue(
      "Break the research question into verifiable steps.",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("inspector-field-maxSteps")).toHaveValue("5");

    // ── Version immutability after reload: v1 untouched by our edits ──────
    await page.getByTestId("builder-tab-versions").click();
    await expect(page.getByTestId("version-item-1")).toContainText("2 nodes");
    await expect(page.getByTestId("version-item-2")).toContainText("4 nodes");
  });

  test("export → import → duplicate round-trips the seeded harness", async ({ page }, testInfo) => {
    await signIn(page);

    // ── Open the seeded demo harness straight from the dashboard ──────────
    await page.getByTestId("project-card-demo-project").click();
    await expect(page).toHaveURL(/\/dashboard\/projects\//);
    await page.getByTestId("open-builder-research-harness").click();
    await expect(page).toHaveURL(/\/builder$/);
    await waitForCanvasSettle(page);
    await expect(builderName(page)).toHaveText("Research harness");

    const nodeCount = await canvasNodes(page).count();
    const edgeCount = await canvasEdges(page).count();
    expect(nodeCount).toBe(6);
    expect(edgeCount).toBe(5);

    // ── Export downloads the harness DSL as JSON ──────────────────────────
    const exportPath = testInfo.outputPath("research-harness.json");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-harness").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^research-harness.*\.json$/);
    await download.saveAs(exportPath);

    // ── Import creates a new harness with the same graph ──────────────────
    await page.locator('input[type="file"]').setInputFiles(exportPath);
    await waitForCanvasSettle(page);
    await expect(builderName(page)).toHaveText("Research harness");
    await expect(canvasNodes(page)).toHaveCount(nodeCount);
    await expect(canvasEdges(page)).toHaveCount(edgeCount);

    // ── Duplicate copies the graph into a new harness at v1 ───────────────
    await page.getByTestId("duplicate-harness").click();
    await expect(page.getByTestId("duplicate-name")).toHaveValue(/Experimental$/);
    await page.getByTestId("duplicate-submit").click();
    await waitForCanvasSettle(page);
    await expect(builderName(page)).toContainText("Experimental");
    await expect(canvasNodes(page)).toHaveCount(nodeCount);
    await expect(canvasEdges(page)).toHaveCount(edgeCount);
    await visibleTestId(page, "builder-tab-versions").click();
    await expect(visibleTestId(page, "version-item-1")).toBeVisible();
  });
});
