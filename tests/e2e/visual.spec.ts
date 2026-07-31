import { expect, test } from "@playwright/test";
import { authenticatedRoutes, snapshotName } from "./routes";
import { expectAuthenticatedRoute, stabilizePage } from "./test-helpers";

for (const route of authenticatedRoutes) {
  test(`${route.path} matches its authenticated visual baseline`, async ({ page }) => {
    await expectAuthenticatedRoute(page, route);
    await stabilizePage(page);
    await expect(page).toHaveScreenshot(snapshotName(route.path), {
      fullPage: true,
    });
  });
}
