import { expect, test } from "@playwright/test";
import { authenticatedRoutes, snapshotName } from "./routes";
import { expectAuthenticatedRoute, stabilizePage } from "./test-helpers";

// Full-page captures draw fixed elements where the viewport ended, so the phone tab
// bar is laid out in flow (at the end of the page) for a deterministic baseline.
const flowTabBar = 'nav[aria-label="Primary"] { position: static !important; }';

for (const route of authenticatedRoutes) {
  test(`${route.path} matches its authenticated visual baseline`, async ({ page }) => {
    await expectAuthenticatedRoute(page, route);
    await stabilizePage(page);
    // The tab bar appears once membership loads; wait for it on phone widths.
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await page.addStyleTag({ content: flowTabBar });
    }
    await expect(page).toHaveScreenshot(snapshotName(route.path), {
      fullPage: true,
    });
  });
}
