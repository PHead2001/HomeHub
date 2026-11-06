/** True when `pathname` is `href` or one of its sub-routes (`/` matches only itself). */
export const isActiveRoute = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
