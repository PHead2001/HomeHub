import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { approvedPeople, publicDisplayName } from '@/lib/member-directory';
import { toDate } from '@/lib/pets/care';
import { readCourse, withOfflineDoses } from '@/lib/pets/medication-course';
import { isDocId } from '@functions/shared/push-media';
import { buildIcs } from '@/lib/calendar/ics';
import { feedEvents, type FeedSources } from '@/lib/calendar/feed-events';
import type { ChoreRecord } from '@/lib/chores/dates';
import { pantryExpiryInputs, type CalendarMember, type CourseEntry, type MedicationEntry, type RecurringTemplate } from '@/lib/chores/calendar';
import { safeTimeZone } from '@functions/shared/calendar';
import type { VerifiedCaller } from '@/lib/server/household-membership';

/**
 * The household's phone calendar feed (audit CA-25): one secret URL per household,
 * `/api/calendar-feed/<token>`, that phone calendars subscribe to.
 *
 * - The token is 32 random bytes (base64url). It is stored only where no client can
 *   read it: `households/{h}/calendar-feed/current` (`token`, `tokenHash`, who made it
 *   and when) for owners and admins to see the URL again, and the lookup
 *   `calendarFeeds/{sha256(token)}` (`householdId`) the route resolves a request with.
 *   The rules deny both paths to every client (Admin SDK only).
 * - Owners and admins (role, from a personal session) turn the feed on, read its URL,
 *   rotate it (the old URL stops at once) and turn it off. Anyone they share the URL
 *   with sees what the feed lists, whatever their own role could see: the feed is the
 *   whole household calendar, which is why only owners and admins hand it out.
 * - A request with an unknown, rotated or malformed token, or for a household that is
 *   gone or being deleted, gets 404 and learns nothing else.
 */

export type CalendarFeedRefusal = 'invalid_input' | 'not_found' | 'household_deleting' | 'not_member' | 'forbidden';

export class CalendarFeedError extends Error {
  constructor(readonly code: CalendarFeedRefusal, message: string) {
    super(message);
  }
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashFeedToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export const newFeedToken = (): string => randomBytes(32).toString('base64url');

export const isFeedToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

const feedDoc = (db: Firestore, householdId: string) => db.collection('households').doc(householdId).collection('calendar-feed').doc('current');
const lookupDoc = (db: Firestore, hash: string) => db.collection('calendarFeeds').doc(hash);

/** An owner or admin (role) of an existing household that is not being deleted, read inside the transaction. */
const assertManager = async (tx: FirebaseFirestore.Transaction, db: Firestore, caller: VerifiedCaller, householdId: unknown): Promise<string> => {
  if (!isDocId(householdId)) throw new CalendarFeedError('not_found', 'That household no longer exists.');
  const house = db.collection('households').doc(householdId);
  const [home, member] = await Promise.all([tx.get(house), tx.get(house.collection('members').doc(caller.uid))]);
  if (!home.exists) throw new CalendarFeedError('not_found', 'That household no longer exists.');
  if (home.get('deletingAt')) throw new CalendarFeedError('household_deleting', 'This household is being deleted.');
  const data = member.data();
  if (!member.exists || (data?.status ?? 'active') !== 'active' || data?.role === 'newuser') throw new CalendarFeedError('not_member', 'You are not part of this household.');
  if (data?.role !== 'owner' && data?.role !== 'admin') throw new CalendarFeedError('forbidden', 'Only owners and admins can share the household calendar.');
  return householdId;
};

/** The current token, or null when the feed is off. Owners and admins only. */
export async function readCalendarFeed(db: Firestore, caller: VerifiedCaller, householdId: unknown): Promise<{ token: string | null }> {
  return db.runTransaction(async (tx) => {
    const id = await assertManager(tx, db, caller, householdId);
    const current = await tx.get(feedDoc(db, id));
    const token = current.get('token');
    return { token: isFeedToken(token) ? token : null };
  });
}

/**
 * Turns the feed on, or rotates it: a new token replaces the old one in one
 * transaction, so the old URL stops working at once.
 */
export async function rotateCalendarFeed(db: Firestore, caller: VerifiedCaller, householdId: unknown, now = new Date()): Promise<{ token: string }> {
  return db.runTransaction(async (tx) => {
    const id = await assertManager(tx, db, caller, householdId);
    const current = await tx.get(feedDoc(db, id));
    const oldHash = current.get('tokenHash');
    const token = newFeedToken();
    const tokenHash = hashFeedToken(token);
    if (typeof oldHash === 'string' && oldHash) tx.delete(lookupDoc(db, oldHash));
    tx.set(lookupDoc(db, tokenHash), { householdId: id, createdAt: Timestamp.fromDate(now), createdByUid: caller.uid });
    tx.set(feedDoc(db, id), { token, tokenHash, createdAt: Timestamp.fromDate(now), createdByUid: caller.uid });
    return { token };
  });
}

/**
 * Removes every feed lookup of a household (deleting the household, step 3 of
 * `deleteHousehold`): the per-household document goes with the household's
 * subcollections, and the lookups, which live outside it, go here, stale ones included.
 */
export async function deleteHouseholdCalendarFeeds(db: Firestore, householdId: string): Promise<number> {
  const lookups = await db.collection('calendarFeeds').where('householdId', '==', householdId).get();
  await Promise.all(lookups.docs.map(lookup => lookup.ref.delete()));
  return lookups.size;
}

/** Turns the feed off: the URL stops working at once. */
export async function disableCalendarFeed(db: Firestore, caller: VerifiedCaller, householdId: unknown): Promise<{ token: null }> {
  return db.runTransaction(async (tx) => {
    const id = await assertManager(tx, db, caller, householdId);
    const current = await tx.get(feedDoc(db, id));
    const oldHash = current.get('tokenHash');
    if (typeof oldHash === 'string' && oldHash) tx.delete(lookupDoc(db, oldHash));
    tx.delete(feedDoc(db, id));
    return { token: null };
  });
}

/**
 * The household a token opens, or null. The lookup is by the token's hash; the
 * household's current hash must match it too (compared in constant time), so a
 * stale lookup left behind can never open a feed.
 */
export async function householdForFeedToken(db: Firestore, token: unknown): Promise<string | null> {
  if (!isFeedToken(token)) return null;
  const hash = hashFeedToken(token);
  const lookup = await lookupDoc(db, hash).get();
  const householdId = lookup.get('householdId');
  if (!lookup.exists || !isDocId(householdId)) return null;
  const [home, current] = await Promise.all([db.collection('households').doc(householdId).get(), feedDoc(db, householdId).get()]);
  if (!home.exists || home.get('deletingAt')) return null;
  const stored = current.get('tokenHash');
  if (typeof stored !== 'string' || stored.length !== hash.length) return null;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(hash)) ? householdId : null;
}

/** Reads what the feed lists (Admin SDK) and builds the events. */
export async function readFeedSources(db: Firestore, householdId: string): Promise<{ name: string; sources: FeedSources }> {
  const house = db.collection('households').doc(householdId);
  const [home, members, chores, templates, assets, vehicles, pets, pantry] = await Promise.all([
    house.get(),
    house.collection('members').get(),
    house.collection('chores').get(),
    house.collection('chore-templates').get(),
    house.collection('home-assets').get(),
    house.collection('vehicles').get(),
    house.collection('pets').get(),
    house.collection('pantry-inventory').get(),
  ]);
  // Public member data only: names come from the membership records, never an email.
  const people: CalendarMember[] = approvedPeople(members.docs.map(d => ({ id: d.id, data: d.data() }))).map(person => ({ uid: person.uid, name: person.displayName }));
  const petData = await Promise.all(pets.docs.map(async (pet) => {
    const petName = publicDisplayName(pet.get('name'), 'Pet');
    const [logs, courses] = await Promise.all([pet.ref.collection('medication-logs').get(), pet.ref.collection('medication-courses').get()]);
    const medication: MedicationEntry[] = logs.docs.map(log => {
      const data = log.data();
      return {
        id: log.id, petId: pet.id, petName, medication: typeof data.medication === 'string' ? data.medication : 'Medication',
        ...(typeof data.dosage === 'string' ? { dosage: data.dosage } : {}),
        date: toDate(data.date as unknown)?.toISOString() ?? '',
        ...(typeof data.nextDueDate === 'string' ? { nextDueDate: data.nextDueDate } : {}),
        ...(typeof data.courseId === 'string' ? { courseId: data.courseId } : {}),
        ...(data.oneOff === true ? { oneOff: true } : {}),
      };
    });
    const courseEntries: CourseEntry[] = courses.docs.flatMap(course => {
      const view = readCourse(course.id, course.data());
      return view ? [{ petId: pet.id, petName, course: withOfflineDoses(view, logs.docs.map(log => ({ id: log.id, ...log.data() }))) }] : [];
    });
    return { medication, courses: courseEntries };
  }));
  return {
    name: typeof home.get('name') === 'string' && home.get('name') ? `${home.get('name')} (HomeHub)` : 'HomeHub',
    sources: {
      timeZone: home.get('timeZone'),
      members: people,
      chores: chores.docs.map(d => ({ id: d.id, ...d.data() } as ChoreRecord)),
      templates: templates.docs.map(d => ({ ...(d.data() as Omit<RecurringTemplate, 'id'>), id: d.id })),
      assets: assets.docs.map(d => ({ ...(d.data() as { name: string }), id: d.id })),
      vehicles: vehicles.docs.map(d => ({ ...(d.data() as { nickname: string }), id: d.id })),
      medication: petData.flatMap(p => p.medication),
      courses: petData.flatMap(p => p.courses),
      // The pantry's own reader, as the calendar page: legacy timestamp expiries and quantities count.
      pantry: pantryExpiryInputs(pantry.docs.map(d => ({ id: d.id, data: d.data() })), safeTimeZone(home.get('timeZone'))),
    },
  };
}

/** The feed text for a household. */
export async function calendarFeedText(db: Firestore, householdId: string, now: Date, baseUrl?: string): Promise<string> {
  const { name, sources } = await readFeedSources(db, householdId);
  return buildIcs(feedEvents(sources, now), { name, now, baseUrl });
}
