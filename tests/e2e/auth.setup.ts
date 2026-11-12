import { expect, test as setup } from "@playwright/test";

import { authenticatedRoutes } from "./routes";

const authFile = "playwright/.auth/e2e-owner.json";

// The dev server compiles each route (and its browser bundles) the first time it is
// requested, which on a slow machine can take longer than a spec's 10-second wait for the
// page heading. Load every route once here, signed out, so no spec pays for a cold compile.
// Signed out on purpose: the pages then read and write nothing (no household upkeep, no
// listeners), so the seeded data is exactly as the first spec expects it.
setup("warm the dev server's routes", async ({ browser }) => {
  setup.setTimeout(300_000);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    for (const path of [...authenticatedRoutes.map((route) => route.path), "/calendar"]) {
      const response = await page.goto(path, { waitUntil: "load", timeout: 120_000 });
      expect(response?.ok(), `${path} loads`).toBeTruthy();
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    }
  } finally {
    await context.close();
  }
});

setup("authenticate with the Firebase Auth Emulator", async ({ page, context }) => {
  await page.goto("/e2e-login");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Welcome Home" })).toBeVisible();
  await context.storageState({ path: authFile, indexedDB: true });
});
