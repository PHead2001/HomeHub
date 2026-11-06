import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { authenticatedRoutes, snapshotName } from "./routes";
import { expectAuthenticatedRoute, stabilizePage } from "./test-helpers";

// Full-page captures draw fixed elements where the viewport ended, so the phone tab
// bar is laid out in flow (at the end of the page) for a deterministic baseline.
const flowTabBar = 'nav[aria-label="Primary"] { position: static !important; }';

// Placeholder pet/product photos come from placehold.co through Next's image
// optimizer; the external image varies and is not always loaded at capture time.
// Serve one fixed local image instead so baselines are deterministic.
const placeholderImage = readFileSync("public/icons/icon-192.png");

for (const route of authenticatedRoutes) {
  test(`${route.path} matches its authenticated visual baseline`, async ({ page }) => {
    await page.route(/placehold\.co/, request => request.fulfill({ status: 200, contentType: "image/png", body: placeholderImage }));
    await expectAuthenticatedRoute(page, route);
    await stabilizePage(page);
    // The tab bar appears once membership loads; wait for it on phone widths.
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await page.addStyleTag({ content: flowTabBar });
    }
    // Every image on the page (including placeholders) is loaded before capture.
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    await expect(page).toHaveScreenshot(snapshotName(route.path), {
      fullPage: true,
    });
  });
}
