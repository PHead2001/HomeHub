import { expect, test as setup } from "@playwright/test";

import { authenticatedRoutes } from "./routes";

const authFile = "playwright/.auth/e2e-owner.json";

setup("authenticate with the Firebase Auth Emulator", async ({ page, context }) => {
  await page.goto("/e2e-login");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Welcome Home" })).toBeVisible();
  await context.storageState({ path: authFile, indexedDB: true });
});

// The dev server compiles each route the first time it is requested, which on a slow
// machine can take longer than a spec's 10-second wait for the page heading. Visit every
// route once here, with a generous wait, so no spec pays for a cold compile.
setup("warm the dev server's routes", async ({ browser }) => {
  setup.setTimeout(300_000);
  const context = await browser.newContext({ storageState: authFile });
  const page = await context.newPage();
  try {
    for (const route of [...authenticatedRoutes, { path: "/calendar", heading: "Calendar" }]) {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { name: route.heading, exact: true }).first()).toBeVisible({ timeout: 60_000 });
    }
  } finally {
    await context.close();
  }
});
