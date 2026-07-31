import { test } from "@playwright/test";
import { authenticatedRoutes } from "./routes";
import { expectAuthenticatedRoute, stabilizePage } from "./test-helpers";

for (const route of authenticatedRoutes) {
  test(`${route.path} loads as the seeded household owner`, async ({ page }) => {
    await expectAuthenticatedRoute(page, route);
    await stabilizePage(page);
  });
}
