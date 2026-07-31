import { expect, test as setup } from "@playwright/test";

const authFile = "playwright/.auth/e2e-owner.json";

setup("authenticate with the Firebase Auth Emulator", async ({ page, context }) => {
  await page.goto("/e2e-login");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Welcome Home" })).toBeVisible();
  await context.storageState({ path: authFile, indexedDB: true });
});
