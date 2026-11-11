import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { fixedNow } from './test-helpers';
import {
  allowedSmall, effectiveBox, findOverlaps, meetsMinimum, parseOffset, parseTranslate, samplePoints,
  type Box, type ControlMeasure, type HitArea, type PseudoStyle,
} from './hit-areas';

/*
 * WT-28 with WT-25 and WT-26: every page other than the dashboard and Shopping on the
 * real wall tablet, 1263 x 818 as an installed web app (touch, coarse pointer). On
 * each page: nothing scrolls sideways; every visible control's effective hit area
 * (its own box grown by its `::after` hit-slop or stretched-link area) is at least
 * 48 x 48 (D-2 on a touch screen); no two hit areas overlap, except a control on top
 * of a card link that wholly contains it, which must then own every tap in its area;
 * and the live counts in section headers render with no gap ("To Do (3)"). A smaller
 * loop covers the other wall sizes and a common 1024 x 768 tablet for sideways
 * overflow and clipped controls, plus 130% text on the primary size.
 */

const baseURL = 'http://127.0.0.1:9002';
const desktopOnly = (testInfo: TestInfo) => test.skip(testInfo.project.name !== 'desktop-chromium');
const TOUCH_MIN = 48;

type Route = { path: string; heading: string; ready: (page: Page) => Locator };
const ROUTES: Route[] = [
  { path: '/chores', heading: 'Chore Chart', ready: (page) => page.getByText('Reset the kitchen').first() },
  { path: '/pets', heading: 'Your Pets', ready: (page) => page.getByRole('link', { name: 'Maple', exact: true }) },
  { path: '/calendar', heading: 'Calendar', ready: (page) => page.getByRole('button', { name: 'Previous week' }) },
  { path: '/maintenance', heading: 'Maintenance Center', ready: (page) => page.getByText('Main HVAC System').first() },
  { path: '/notifications', heading: 'Notification Center', ready: (page) => page.getByText('HVAC filter due today').first() },
  { path: '/household', heading: 'Manage Household', ready: (page) => page.getByText('The Foxy Residence E2E').first() },
  { path: '/profile', heading: 'Your Profile', ready: (page) => page.getByText('Personal Information').first() },
  { path: '/library', heading: 'Barcode Library', ready: (page) => page.getByText('E2E Oat Cereal').first() },
  { path: '/automation', heading: 'House Automation', ready: (page) => page.getByText('Connect Home Assistant').first() },
];

async function openTablet(browser: Browser, viewport: { width: number; height: number }) {
  // The wall tablet is a touch screen: Chromium's touch emulation also reports a
  // coarse primary pointer (asserted below), so `--target-min` is 48 px. Reduced
  // motion settles staggered rows and ticking counts at once.
  const context = await browser.newContext({
    baseURL,
    viewport,
    hasTouch: true,
    reducedMotion: 'reduce',
    storageState: 'playwright/.auth/e2e-owner.json',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(fixedNow);
  return { context, page };
}

async function openRoute(page: Page, route: Route) {
  await page.goto(route.path);
  await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible();
  await expect(route.ready(page)).toBeVisible();
  await expect(page.getByText('Sign in with Google', { exact: false })).toHaveCount(0);
}

async function setTextScale(page: Page, scale: 100 | 115 | 130) {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.dataset.textScale = String(value);
    root.style.fontSize = `${value}%`;
  }, scale);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Marks every visible interactive control with `data-hit-id` and returns its raw
 * geometry (in viewport coordinates at the current scroll position). Visually hidden
 * controls (1 px, sr-only) are kept only when they sit in a label, whose box is then
 * their hit area; hidden, inert, aria-hidden and pointer-events:none controls are skipped.
 */
async function measureControls(page: Page): Promise<ControlMeasure[]> {
  const raw = await page.evaluate(() => {
    const SELECTOR = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
      '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
      // Focusable containers count too, but not composite widget roots (Radix puts
      // tabindex on tab lists, radio and toggle groups) or tab panels: their items are the targets.
      '[tabindex]:not([tabindex="-1"]):not([role="tabpanel"]):not([role="tablist"]):not([role="radiogroup"]):not([role="group"]):not([role="toolbar"])',
    ].join(',');
    const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    document.querySelectorAll('[data-hit-id]').forEach((el) => el.removeAttribute('data-hit-id'));
    const elements = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => {
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      if (getComputedStyle(el).pointerEvents === 'none') return false;
      const rect = el.getBoundingClientRect();
      const hidden = rect.width <= 2 || rect.height <= 2;
      return !hidden || Boolean(el.closest('label'));
    });
    elements.forEach((el, index) => el.setAttribute('data-hit-id', String(index)));
    return elements.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const visuallyHidden = rect.width <= 2 || rect.height <= 2;
      const pseudo = getComputedStyle(el, '::after');
      let after = null;
      let containingBlock = null;
      const hasPseudo = pseudo.content !== 'none' && pseudo.content !== 'normal' && pseudo.display !== 'none';
      if (!visuallyHidden && hasPseudo && (pseudo.position === 'absolute' || pseudo.position === 'fixed')) {
        const positioned = getComputedStyle(el).position !== 'static';
        const block = pseudo.position === 'fixed' ? null : (positioned ? el : el.offsetParent as HTMLElement | null);
        const blockRect = block ? block.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
        // The padding box: inside the borders.
        containingBlock = block
          ? { x: blockRect.x + block.clientLeft, y: blockRect.y + block.clientTop, width: block.clientWidth, height: block.clientHeight }
          : box(blockRect);
        after = {
          left: pseudo.left, top: pseudo.top, right: pseudo.right, bottom: pseudo.bottom,
          width: pseudo.width, height: pseudo.height, transform: pseudo.transform,
        };
      }
      const label = el.closest('label');
      const parentParagraph = el.closest('p');
      return {
        id: index,
        name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 60),
        own: box(rect),
        after,
        containingBlock,
        label: label ? box(label.getBoundingClientRect()) : null,
        contains: elements.flatMap((other, otherIndex) => (other !== el && el.contains(other) ? [otherIndex] : [])),
        inlineTextLink: el.tagName === 'A' && getComputedStyle(el).display === 'inline' && Boolean(parentParagraph),
        visuallyHidden,
      };
    });
  });
  return raw.map((item) => {
    let after: PseudoStyle | null = null;
    if (item.after) {
      const { tx, ty } = parseTranslate(item.after.transform);
      after = {
        left: parseOffset(item.after.left),
        top: parseOffset(item.after.top),
        right: parseOffset(item.after.right),
        bottom: parseOffset(item.after.bottom),
        width: Number.parseFloat(item.after.width) || 0,
        height: Number.parseFloat(item.after.height) || 0,
        tx,
        ty,
      };
    }
    return { ...item, after };
  });
}

/**
 * For a control on top of a larger hit area (a card link), scrolls it into view and
 * hit-tests its centre and inset corners: each must land on the control itself.
 * Returns the points that did not.
 */
async function stolenPoints(page: Page, inner: HitArea, own: Box) {
  return page.evaluate(({ id, own: before, points }) => {
    const el = document.querySelector<HTMLElement>(`[data-hit-id="${id}"]`);
    if (!el) return ['missing'];
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const dx = rect.x - before.x;
    const dy = rect.y - before.y;
    return points.flatMap(({ x, y }) => {
      const hit = document.elementFromPoint(x + dx, y + dy);
      return hit && (hit === el || el.contains(hit)) ? [] : [`(${Math.round(x + dx)}, ${Math.round(y + dy)}) hits ${hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('aria-label') ? ` "${hit.getAttribute('aria-label')}"` : ''}` : 'nothing'}`];
    });
  }, { id: inner.id, own, points: samplePoints(inner.box) });
}

async function expectTouchTargets(page: Page, path: string) {
  const controls = await measureControls(page);
  expect(controls.length, `${path}: the page has controls to measure`).toBeGreaterThan(3);

  const tooSmall = controls.flatMap((control) => {
    const area = effectiveBox(control);
    if (meetsMinimum(area, TOUCH_MIN) || allowedSmall(control, TOUCH_MIN)) return [];
    return [`${control.name}: ${Math.round(area.width)} x ${Math.round(area.height)}`];
  });
  expect(tooSmall, `${path}: every control's hit area is at least ${TOUCH_MIN} x ${TOUCH_MIN} on a touch screen`).toEqual([]);

  const areas: HitArea[] = controls.map((control) => ({ id: control.id, name: control.name, box: effectiveBox(control), contains: control.contains }));
  const overlaps = findOverlaps(areas);
  const partial = overlaps.filter((overlap) => overlap.kind === 'partial').map((overlap) => `"${overlap.a.name}" and "${overlap.b.name}"`);
  expect(partial, `${path}: no two neighbouring hit areas overlap`).toEqual([]);

  // A control on a card whose link covers the card: the control must be on top.
  for (const overlap of overlaps.filter((item) => item.kind === 'contained')) {
    const inner = overlap.inner!;
    const own = controls.find((control) => control.id === inner.id)!.own;
    const stolen = await stolenPoints(page, inner, own);
    const outer = overlap.a.id === inner.id ? overlap.b : overlap.a;
    expect(stolen, `${path}: "${inner.name}" owns its whole hit area on top of "${outer.name}"`).toEqual([]);
    // Measurements are per scroll position: re-measure from the top for the next pair.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
}

/** A live count (NumberTicker) sits right against the text around it: "(3)", never "(   3   )". */
async function expectCountsWithoutGaps(page: Page, label: Locator, description: string) {
  await expect(label).toHaveText(/\(\s?\d+\s?\)/);
  const gaps = await label.evaluate((element) => {
    const ticker = element.querySelector<HTMLElement>('[data-number-ticker]');
    if (!ticker) return null;
    const textWidth = (node: Node | null) => {
      if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const rect = ticker.getBoundingClientRect();
    const own = textWidth(ticker.firstChild);
    const before = textWidth(ticker.previousSibling);
    const after = textWidth(ticker.nextSibling);
    return {
      widthExcess: own ? rect.width - own.width : null,
      before: before ? rect.left - before.right : null,
      after: after ? after.left - rect.right : null,
    };
  });
  expect(gaps, `${description}: the count is a live number`).not.toBeNull();
  // The count is exactly as wide as its digits ...
  expect(gaps!.widthExcess!, `${description}: the count is as wide as its text`).toBeLessThanOrEqual(1);
  // ... and touches the brackets around it (a flex gap or justify-between would open space here).
  expect(gaps!.before, `${description}: no gap after "("`).not.toBeNull();
  expect(gaps!.before!, `${description}: no gap after "("`).toBeLessThanOrEqual(2);
  expect(gaps!.after, `${description}: no gap before ")"`).not.toBeNull();
  expect(gaps!.after!, `${description}: no gap before ")"`).toBeLessThanOrEqual(2);
}

test.describe('WT-28: pages on the wall tablet (1263 x 818, touch)', () => {
  for (const route of ROUTES) {
    test(`${route.path}: no sideways scroll, 48 px touch targets, no overlapping hit areas`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      const { context, page } = await openTablet(browser, { width: 1263, height: 818 });
      try {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch emulation reports a coarse pointer').toBe(true);
        await openRoute(page, route);
        expect(await sideways(page), `${route.path}: no horizontal overflow`).toBeLessThanOrEqual(0);
        await expectTouchTargets(page, route.path);
      } finally {
        await context.close();
      }
    });
  }

  test('/chores and /calendar: header counts render with no gap', async ({ browser }, testInfo) => {
    desktopOnly(testInfo);
    const { context, page } = await openTablet(browser, { width: 1263, height: 818 });
    try {
      await openRoute(page, ROUTES[0]);
      await expectCountsWithoutGaps(page, page.getByRole('button', { name: /^To Do \(\d+\)$/ }), 'To Do');
      const rooms = page.getByRole('button', { name: /^Kitchen \(\d+\)$/ });
      await expect(rooms.first()).toBeVisible();
      await expectCountsWithoutGaps(page, rooms.first(), 'Kitchen room group');
      await expectCountsWithoutGaps(page, page.getByRole('button', { name: /^Future \(\d+\)$/ }), 'Future');
      await expectCountsWithoutGaps(page, page.getByRole('button', { name: /^Completed \(\d+\)$/ }), 'Completed');

      await openRoute(page, ROUTES[2]);
      await expectCountsWithoutGaps(page, page.getByRole('heading', { name: /^Overdue \(\d+\)$/ }), 'Calendar overdue rail');
    } finally {
      await context.close();
    }
  });
});

/**
 * Visible controls that run past the viewport's sides. Controls inside a sideways
 * scroller (chip rows, the overdue rail) and the header's links (the nav measures
 * which fit and moves the rest into More) are meant to clip there.
 */
async function clippedControls(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input:not([type="hidden"]), select, textarea, [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]'))
    .filter((el) => !el.closest('[aria-hidden="true"], [inert], nav[aria-label="Main"]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return false;
        parent = parent.parentElement;
      }
      return true;
    })
    .flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return [];
      return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1
        ? [`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)}: ${Math.round(rect.left)}..${Math.round(rect.right)}`]
        : [];
    }));
}

test.describe('WT-25: the same pages on other landscape sizes and at 130% text', () => {
  const SIZES = [
    { width: 1263, height: 722, scale: 100 as const },
    { width: 1264, height: 843, scale: 100 as const },
    { width: 1024, height: 768, scale: 100 as const },
    { width: 1263, height: 818, scale: 130 as const },
  ];
  for (const size of SIZES) {
    test(`${size.width}x${size.height} at ${size.scale}% text: no sideways scroll or clipped controls`, async ({ browser }, testInfo) => {
      desktopOnly(testInfo);
      const { context, page } = await openTablet(browser, size);
      try {
        for (const route of ROUTES) {
          await openRoute(page, route);
          if (size.scale !== 100) await setTextScale(page, size.scale);
          expect(await sideways(page), `${route.path}: no horizontal overflow`).toBeLessThanOrEqual(0);
          expect(await clippedControls(page), `${route.path}: no control runs off the screen`).toEqual([]);
        }
      } finally {
        await context.close();
      }
    });
  }
});
