import { expect, type Page } from "@playwright/test";

export const fixedNow = new Date("2026-08-01T12:00:00.000Z");

export async function stabilizePage(page: Page) {
  await page.clock.setFixedTime(fixedNow);
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
}

export async function expectAuthenticatedRoute(
  page: Page,
  route: { path: string; heading: string; content: string }
) {
  await page.goto(route.path);
  await expect(page).toHaveURL(new RegExp(`${route.path === "/" ? "/?$" : `${route.path}/?$`}`));
  await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
  await expect(page.getByText(route.content, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Sign in with Google", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Welcome to HomeHub!", { exact: true })).toHaveCount(0);
}
