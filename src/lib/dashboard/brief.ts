/**
 * The morning brief (H04): one sentence built from exact dashboard facts. No model
 * is involved, so counts are always HomeHub's own. Each noun phrase that points at
 * a module carries an `href` so the UI can render it as a link.
 */
import type { DashboardFacts } from './facts';
import { MAINTENANCE_REMINDERS_HREF, PANTRY_HREF, choresFilteredHref, petFeedingHref } from './links';

/** What a linked phrase points at, so the UI can show its peek card (H26). */
export type BriefPeek =
  /** `mine`: the reader's own chores; `household`: everyone's (the HP-3a fallback). */
  | { kind: 'chores'; scope: 'mine' | 'household' }
  | { kind: 'pet'; id: string }
  | { kind: 'pets' }
  | { kind: 'pantry' }
  | { kind: 'maintenance' }
  | { kind: 'shopping' };

export type BriefSegment = { text: string; href?: string; peek?: BriefPeek };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const joinPhrases = (phrases: BriefSegment[][]): BriefSegment[] => {
  const out: BriefSegment[] = [];
  phrases.forEach((phrase, index) => {
    if (index > 0) out.push({ text: index === phrases.length - 1 ? (phrases.length > 2 ? ', and ' : ' and ') : ', ' });
    out.push(...phrase);
  });
  return out;
};

const firstName = (name: string | undefined | null) => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  return trimmed.includes('@') ? trimmed.split('@')[0] : trimmed.split(/\s+/)[0];
};

/**
 * Builds the brief. Returns segments (plain text plus links) and the flat text,
 * which is also the cache key for "already typed today".
 */
export function buildMorningBrief(facts: DashboardFacts, options: { greeting: string; name?: string | null }): {
  segments: BriefSegment[];
  text: string;
} {
  const phrases: BriefSegment[][] = [];

  const chores = facts.chores;
  if (chores) {
    const today = chores.mineDueToday;
    const mine: BriefPeek = { kind: 'chores', scope: 'mine' };
    const household: BriefPeek = { kind: 'chores', scope: 'household' };
    // HP-3a: with nothing of your own, the household's open work is named instead, so the
    // brief never says "Nothing needs you" while the house has overdue chores.
    const houseToday = Math.max(0, chores.todayTotal - chores.todayDone);
    const houseOverdue = chores.overdueTotal;
    // HP-25: overdue phrases open Chores filtered to overdue (`&who=me` for your own);
    // your chores today open it filtered to you.
    const mineHref = choresFilteredHref({ mine: true });
    const mineOverdueHref = choresFilteredHref({ overdue: true, mine: true });
    const houseOverdueHref = choresFilteredHref({ overdue: true });
    if (chores.mineOverdue > 0 && today > 0) {
      phrases.push([
        { text: `${plural(today, 'chore')} today`, href: mineHref, peek: mine },
        { text: ' (' },
        { text: `${chores.mineOverdue} overdue`, href: mineOverdueHref, peek: mine },
        { text: ')' },
      ]);
    } else if (chores.mineOverdue > 0) {
      phrases.push([{ text: `${plural(chores.mineOverdue, 'overdue chore')}`, href: mineOverdueHref, peek: mine }]);
    } else if (today > 0) {
      phrases.push([{ text: `${plural(today, 'chore')} today`, href: mineHref, peek: mine }]);
    } else if (houseOverdue > 0 && houseToday > 0) {
      phrases.push([
        { text: `${plural(houseToday, 'household chore')} today`, href: '/chores', peek: household },
        { text: ' (' },
        { text: `${houseOverdue} overdue`, href: houseOverdueHref, peek: household },
        { text: ')' },
      ]);
    } else if (houseOverdue > 0) {
      phrases.push([{ text: plural(houseOverdue, 'overdue household chore'), href: houseOverdueHref, peek: household }]);
    } else if (houseToday > 0) {
      phrases.push([{ text: `${plural(houseToday, 'household chore')} today`, href: '/chores', peek: household }]);
    }
  }

  const pets = facts.pets;
  if (pets && pets.pets.length > 0) {
    // Only pets known to be unfed; an unavailable history (fed === null) makes no claim.
    const hungry = pets.pets.filter((pet) => pet.fed === false);
    if (hungry.length === 1) {
      phrases.push([{ text: `${hungry[0].name}'s next meal`, href: petFeedingHref(hungry[0].id), peek: { kind: 'pet', id: hungry[0].id } }, { text: ' is due' }]);
    } else if (hungry.length > 1) {
      phrases.push([{ text: `${plural(hungry.length, 'pet')} to feed`, href: '/pets', peek: { kind: 'pets' } }]);
    }
  }

  const pantry = facts.pantry;
  if (pantry && pantry.nearest.length > 0 && pantry.nearest[0].days <= 2) {
    const item = pantry.nearest[0];
    // HP-22a: the item keeps its own case (brand names), and "expiring tomorrow" needs no
    // verb agreement ("the eggs expiring tomorrow").
    phrases.push([{ text: `the ${item.name}`, href: PANTRY_HREF, peek: { kind: 'pantry' } }, { text: ` ${item.label}` }]);
  } else if (pantry && pantry.expired > 0) {
    phrases.push([{ text: `${plural(pantry.expired, 'pantry item')} expired`, href: PANTRY_HREF, peek: { kind: 'pantry' } }]);
  }

  const maintenance = facts.maintenance;
  if (maintenance && maintenance.overdue > 0) {
    phrases.push([{ text: `${plural(maintenance.overdue, 'maintenance task')} overdue`, href: MAINTENANCE_REMINDERS_HREF, peek: { kind: 'maintenance' } }]);
  } else if (maintenance?.next && maintenance.next.status === 'due_today') {
    // The reminder's own status (date or mileage), never recomputed from dates.
    phrases.push([{ text: maintenance.next.label, href: maintenance.next.href, peek: { kind: 'maintenance' } }, { text: ` (${maintenance.next.statusLabel.toLowerCase()})` }]);
  }

  if (phrases.length === 0 && facts.shopping && facts.shopping.neededItems > 0) {
    phrases.push([{ text: `${plural(facts.shopping.neededItems, 'item')} on your lists`, href: '/shopping', peek: { kind: 'shopping' } }]);
  }

  const incomplete = Boolean(facts.unavailable?.length || facts.pets?.unknown);
  const name = firstName(options.name);
  const opener = `${options.greeting}${name ? `, ${name}` : ''}. `;
  const body: BriefSegment[] = phrases.length > 0
    ? (() => {
        const joined = joinPhrases(phrases);
        // Capitalize the first visible letter.
        const first = joined[0];
        joined[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
        return [...joined, { text: '.' }];
      })()
    : incomplete
      ? [{ text: 'Some of your home could not be loaded right now, so there may be more to do.' }]
      : [{ text: 'Nothing needs you right now. Enjoy the quiet.' }];
  // A failed read is never summarized as "nothing to do".
  if (incomplete && phrases.length > 0) body.push({ text: ' Some sections could not be loaded.' });

  const segments = [{ text: opener }, ...body];
  return { segments, text: segments.map((segment) => segment.text).join('') };
}
