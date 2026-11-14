// Start page and section rules on a registered wall tablet (docs/modules/devices/README.md,
// "Tablet shell"; design 14.5, D-T18, WT-4c, WT-11b). Pure: shared by the shell's
// navigation, its deep-link handling and the unit tests.
//
// - The start page comes from the device record. A start page in a section that is off,
//   or whose room or list no longer exists, falls back to Home (the record is not
//   rewritten from the tablet; the server already refuses saving such a pair).
// - A switched-off section is absent from the rail, More, quick add and the resting view;
//   a deep link or notification link into it, or into anything the tablet never shows
//   (Profile, Household, Automation, Library, Setup), lands on the start page.

import { DEVICE_SECTION_LABELS, startPageSection } from './settings';
import type { DeviceSectionKey, DeviceSections, DeviceStartPage } from './types';

/** What the tablet shows. `notices`: household-wide notifications (always on). */
export type TabletView =
  | { kind: 'home' }
  | { kind: 'section'; section: DeviceSectionKey; roomId?: string; listId?: string }
  | { kind: 'notices' };

export const SECTION_PATHS: Record<DeviceSectionKey, string> = {
  chores: '/chores',
  shopping: '/shopping',
  pets: '/pets',
  calendar: '/calendar',
  maintenance: '/maintenance',
};

export const NOTICES_PATH = '/notifications';

/** The tablet view a path (with optional query) points at, or null when a tablet never shows it. */
export function viewOfPath(path: string): TabletView | null {
  let url: URL;
  try {
    url = new URL(path, 'https://tablet.invalid');
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { kind: 'home' };
  const [first] = segments;
  if (first === 'notifications') return { kind: 'notices' };
  const section = (Object.keys(SECTION_PATHS) as DeviceSectionKey[]).find((key) => SECTION_PATHS[key] === `/${first}`);
  if (!section) return null;
  const roomId = section === 'chores' ? url.searchParams.get('room') || undefined : undefined;
  const listId = section === 'shopping' ? url.searchParams.get('list') || undefined : undefined;
  return { kind: 'section', section, ...(roomId ? { roomId } : {}), ...(listId ? { listId } : {}) };
}

export function pathOfView(view: TabletView): string {
  if (view.kind === 'home') return '/';
  if (view.kind === 'notices') return NOTICES_PATH;
  const base = SECTION_PATHS[view.section];
  if (view.roomId) return `${base}?room=${encodeURIComponent(view.roomId)}`;
  if (view.listId) return `${base}?list=${encodeURIComponent(view.listId)}`;
  return base;
}

export const viewAllowed = (view: TabletView, sections: DeviceSections): boolean =>
  view.kind !== 'section' || sections[view.section] === true;

/**
 * What the tablet knows exists right now. `undefined` = not loaded yet (the target is
 * trusted until the data says otherwise, so a slow start does not bounce to Home).
 */
export type KnownTargets = { roomIds?: ReadonlySet<string>; listIds?: ReadonlySet<string> };

/** The view the start page opens, with `fallback` when it fell back to Home (D-T18, WT-4c). */
export function startView(startPage: DeviceStartPage, sections: DeviceSections, known: KnownTargets = {}): { view: TabletView; fallback: boolean } {
  const section = startPageSection(startPage);
  if (!section) return { view: { kind: 'home' }, fallback: false };
  if (!sections[section]) return { view: { kind: 'home' }, fallback: true };
  if (startPage.kind === 'chores-room') {
    if (known.roomIds && !known.roomIds.has(startPage.roomId)) return { view: { kind: 'home' }, fallback: true };
    return { view: { kind: 'section', section: 'chores', roomId: startPage.roomId }, fallback: false };
  }
  if (startPage.kind === 'shopping-list') {
    if (known.listIds && !known.listIds.has(startPage.listId)) return { view: { kind: 'home' }, fallback: true };
    return { view: { kind: 'section', section: 'shopping', listId: startPage.listId }, fallback: false };
  }
  return { view: { kind: 'section', section }, fallback: false };
}

/**
 * Where a requested path (address bar, deep link, notification or brief link) lands:
 * the path itself when the tablet shows it and its section is on, otherwise the start
 * page (`redirected`).
 */
export function resolveTabletPath(
  path: string,
  settings: { sections: DeviceSections; startPage: DeviceStartPage },
  known: KnownTargets = {},
): { view: TabletView; redirected: boolean } {
  const view = viewOfPath(path);
  if (view && viewAllowed(view, settings.sections)) {
    // A room or list that no longer exists shows the whole section.
    if (view.kind === 'section' && view.roomId && known.roomIds && !known.roomIds.has(view.roomId)) return { view: { kind: 'section', section: 'chores' }, redirected: true };
    if (view.kind === 'section' && view.listId && known.listIds && !known.listIds.has(view.listId)) return { view: { kind: 'section', section: 'shopping' }, redirected: true };
    return { view, redirected: false };
  }
  return { view: startView(settings.startPage, settings.sections, known).view, redirected: true };
}

export type TabletNavItem = { key: 'home' | DeviceSectionKey | 'notices'; label: string; path: string };

/** The rail (Home, Chores, Shopping, Pets, Calendar; Maintenance and notices in More), sections that are off left out. */
export function tabletNavItems(sections: DeviceSections): { rail: TabletNavItem[]; more: TabletNavItem[] } {
  const item = (key: DeviceSectionKey): TabletNavItem => ({ key, label: DEVICE_SECTION_LABELS[key], path: SECTION_PATHS[key] });
  const rail: TabletNavItem[] = [{ key: 'home', label: 'Home', path: '/' }];
  for (const key of ['chores', 'shopping', 'pets', 'calendar'] as const) if (sections[key]) rail.push(item(key));
  const more: TabletNavItem[] = [];
  if (sections.maintenance) more.push(item('maintenance'));
  more.push({ key: 'notices', label: 'Household notices', path: NOTICES_PATH });
  return { rail, more };
}

export const sameView = (a: TabletView, b: TabletView): boolean => pathOfView(a) === pathOfView(b);
