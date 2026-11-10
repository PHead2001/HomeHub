/** True when `pathname` is `href` or one of its sub-routes (`/` matches only itself). */
export const isActiveRoute = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/**
 * How many header links fit in `available` px (SL-7): all of them when they fit
 * side by side, otherwise the most leading links that fit next to the "More" menu
 * (which then holds the rest). `widths` are the links' rendered widths in order and
 * `gap` the space between neighbors. Never negative; 0 means everything is in More.
 */
export function fittingLinkCount(widths: readonly number[], available: number, moreWidth: number, gap = 0): number {
  const span = (count: number) =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) + Math.max(0, count - 1) * gap;
  if (span(widths.length) <= available) return widths.length;
  let count = 0;
  while (count < widths.length && span(count + 1) + gap + moreWidth <= available) count += 1;
  return count;
}
