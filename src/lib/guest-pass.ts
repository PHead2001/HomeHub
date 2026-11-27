/**
 * Guest passes (audit HO-14, HO-24; WT-21): time-limited access for a babysitter, a dog
 * walker or a visiting relative. Pure; shared by the server actions, the Household
 * Manager, the live membership and the tablet roster.
 *
 * - **Account pass:** an invite code with a pass length (4 hours, 1 day or 1 week). The
 *   person joins with their own Google account and waits for approval as usual; approving
 *   them as Guest starts the pass: the membership record gets `accessUntil` (a Firestore
 *   Timestamp, approval time plus the length). From that moment the rules, Storage rules,
 *   server actions and push delivery treat the record as inactive, and the Household
 *   Manager removes it (`expireGuestPassesAction`), logged as `member.guest_pass_ended`.
 * - **Tablet pass** (WT-21): a temporary face on registered wall tablets with no account
 *   behind it (`members/guest_<id>`, `kind: 'identity'`, role Guest, `accessUntil`),
 *   allowed only what the pass says (feed pets, tick chores). It shows in "Who's here?"
 *   only until `accessUntil`, and everything done under it is logged under its name.
 */

import type { HouseholdPermission, PermissionOverrides } from '@/lib/types';

/** The pass lengths an invite may carry, in hours: 4 hours, 1 day, 1 week. */
export const GUEST_PASS_HOURS = [4, 24, 168] as const;
export type GuestPassHours = (typeof GUEST_PASS_HOURS)[number];

/** A tablet pass lasts at most this long. */
export const TABLET_PASS_MAX_HOURS = 168;

export const GUEST_IDENTITY_PREFIX = 'guest_';
export const GUEST_NAME_MAX = 40;

export function readGuestPassHours(value: unknown): GuestPassHours | null {
  return typeof value === 'number' && (GUEST_PASS_HOURS as readonly number[]).includes(value) ? value as GuestPassHours : null;
}

export function guestPassLabel(hours: GuestPassHours): string {
  return hours === 4 ? '4 hours' : hours === 24 ? '1 day' : '1 week';
}

/**
 * Milliseconds of a stored `accessUntil`: a Firestore Timestamp (client or Admin SDK,
 * anything with `toMillis`), a Date, an ISO string or a number; null when absent or
 * unreadable.
 */
export function accessUntilMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Whether a membership record's pass has ended at `nowMs`. A record without
 * `accessUntil` never ends this way. An unreadable value counts as ended (fail closed),
 * as in the rules, which compare it with the request time.
 */
export function guestPassEnded(record: { accessUntil?: unknown } | null | undefined, nowMs: number): boolean {
  if (!record || record.accessUntil === undefined || record.accessUntil === null) return false;
  const until = accessUntilMs(record.accessUntil);
  return until === null || until <= nowMs;
}

/**
 * Whether a membership record may act right now: status active (a record without one is
 * active) and no guest pass that has ended. Every server-side membership check that used
 * to read only `status` goes through this (HO-14), so an ended pass is refused before any
 * sweep removes it.
 */
export function memberIsCurrent(
  record: { status?: unknown; accessUntil?: unknown } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!record) return false;
  return (record.status ?? 'active') === 'active' && !guestPassEnded(record, nowMs);
}

/** Whether a record is a pass (account or tablet) at all. */
export const hasGuestPass = (record: { accessUntil?: unknown } | null | undefined): boolean =>
  Boolean(record) && record!.accessUntil !== undefined && record!.accessUntil !== null;

export const isGuestIdentityUid = (value: unknown): value is string =>
  typeof value === 'string' && /^guest_[A-Za-z0-9]{20}$/.test(value);

/** A tablet pass name: trimmed, 1-40 characters, never an email address. */
export function readGuestName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > GUEST_NAME_MAX || /\S+@\S+/.test(name)) return null;
  return name;
}

/** What a tablet pass may do, as permission overrides on the Guest role (view-only otherwise). */
export type TabletPassAbilities = { feedPets?: boolean; tickChores?: boolean };

export function tabletPassOverrides(abilities: TabletPassAbilities): PermissionOverrides {
  const overrides: PermissionOverrides = {};
  if (abilities.feedPets) overrides['pets.addLogs' as HouseholdPermission] = true;
  if (abilities.tickChores) overrides['chores.complete' as HouseholdPermission] = true;
  return overrides;
}

/** The end of a tablet pass: a valid instant after `nowMs` and at most a week later, else null. */
export function readTabletPassUntil(value: unknown, nowMs: number): number | null {
  const ms = accessUntilMs(value);
  if (ms === null || ms <= nowMs || ms > nowMs + TABLET_PASS_MAX_HOURS * 60 * 60 * 1000) return null;
  return ms;
}

/** "until 11:00 PM" today, or "until Sat 11:00 PM" on another day, in the household's zone. */
export function passUntilText(untilMs: number, nowMs: number, timeZone?: string): string {
  const zone = timeZone || undefined;
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(untilMs);
  if (day(untilMs) === day(nowMs)) return `until ${time}`;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(untilMs);
  return `until ${weekday}, ${time}`;
}
