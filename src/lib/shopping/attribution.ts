/**
 * "Sam added · 2d" under an item's name (SH-28b). Names come from the household's
 * member records (display names only, never emails); an unknown or unnamed member
 * reads "Member". Items written before attribution existed show nothing.
 */

/** uid -> display name, from the household's `members` documents (no emails). */
export function memberNameMap(members: ReadonlyArray<{ uid?: unknown; displayName?: unknown }>): Map<string, string> {
  const names = new Map<string, string>();
  for (const member of members) {
    if (typeof member.uid !== 'string' || !member.uid) continue;
    const name = typeof member.displayName === 'string' ? member.displayName.trim() : '';
    // A display name that is an email address is not shown (privacy): "Member" instead.
    names.set(member.uid, name && !name.includes('@') ? firstName(name) : 'Member');
  }
  return names;
}

const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** Epoch ms of a Date, a Firestore Timestamp, an ISO string or a number; null when unknown. */
export function toMillis(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
}

/** "now", "5m", "3h", "2d", "3w" since `then`. */
export function shortAge(then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * The attribution line for an item, or null when it has no `addedByUid`.
 * The signed-in member reads "You added"; others by name, else "Member".
 */
export function attributionLabel({
  addedByUid,
  createdAt,
  currentUid,
  names,
  now,
}: {
  addedByUid?: string | null;
  createdAt?: unknown;
  currentUid?: string | null;
  names: ReadonlyMap<string, string>;
  now: number;
}): string | null {
  if (!addedByUid) return null;
  const who = addedByUid === currentUid ? 'You' : names.get(addedByUid) ?? 'Member';
  const when = toMillis(createdAt);
  return when === null ? `${who} added` : `${who} added · ${shortAge(when, now)}`;
}
