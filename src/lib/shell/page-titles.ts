import type { Metadata } from 'next';

/**
 * SL-13: every page has its own title ("Chores - HomeHub"), so screen readers announce
 * the new page on navigation and tabs and history entries tell pages apart. The root
 * layout sets the template; each section's segment sets its name. A title that must
 * not get the suffix uses `{ absolute }`.
 */
export const APP_TITLE = 'HomeHub';
export const TITLE_TEMPLATE = `%s - ${APP_TITLE}`;

export const SECTION_TITLES = {
  shopping: 'Shopping',
  pets: 'Pets',
  maintenance: 'Maintenance',
  chores: 'Chores',
  calendar: 'Calendar',
  automation: 'Automation',
  household: 'Household',
  library: 'Barcode Library',
  notifications: 'Notifications',
  profile: 'Profile',
  setup: 'Set up a wall tablet',
  offline: 'Offline',
  notFound: 'Page not found',
} as const;

export type SectionTitleKey = keyof typeof SECTION_TITLES;

/** The root layout's title: "HomeHub" on the dashboard, "<page> - HomeHub" elsewhere. */
export const ROOT_TITLE: Metadata['title'] = { default: APP_TITLE, template: TITLE_TEMPLATE };

/** A section segment's metadata (its `layout.tsx` or server `page.tsx`). */
export function sectionMetadata(key: SectionTitleKey): Metadata {
  return { title: SECTION_TITLES[key] };
}

/** What the browser shows for a section: the template applied to its name. */
export function documentTitle(key: SectionTitleKey | null): string {
  return key ? TITLE_TEMPLATE.replace('%s', SECTION_TITLES[key]) : APP_TITLE;
}
