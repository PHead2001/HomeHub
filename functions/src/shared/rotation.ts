// Rotations (audit CH-28): a repeating chore can take turns between people.
// A template's `rotation` lists member uids in order; occurrence number n
// (counted from the template's `rotationStart` day) goes to rotation[n % k].
// The count includes skipped days (CH-3), so skipping one day never shifts
// anyone else's turn, and it does not depend on when upkeep runs, so every
// run (and the calendar) gives each day the same person. All rooms of one
// day go to the same person. A uid that is no longer a member (or cannot be
// assigned) passes its turn to the next person in the list. Shared by the web
// app and Cloud Functions. Pure.
import {addDays, diffDays, isDayString} from "./calendar";
import {occursOn, type NormalizedRecurrence} from "./recurrence";

/** Most people in one rotation. */
export const MAX_ROTATION = 8;

/** Counting anchor for a rotation saved without a start day. */
export const ROTATION_EPOCH = "2024-01-01";

/** Longest span counted (about 30 years), so a bad anchor stays cheap. */
const MAX_SPAN_DAYS = 11000;

/**
 * A template's rotation: unique non-empty uids, in order, at most
 * MAX_ROTATION. Fewer than two people is no rotation (empty).
 * @param {object} template Stored template fields.
 * @return {string[]} The uids.
 */
export const rotationOf = (
  template: {rotation?: unknown} | null | undefined,
): string[] => {
  const list = template?.rotation;
  if (!Array.isArray(list)) return [];
  const uids: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const uid = value.trim();
    if (uid && !uids.includes(uid)) uids.push(uid);
  }
  return uids.length >= 2 ? uids.slice(0, MAX_ROTATION) : [];
};

/**
 * The day a rotation counts from: `rotationStart`, else ROTATION_EPOCH.
 * @param {object} template Stored template fields.
 * @return {string} Day string.
 */
export const rotationAnchor = (
  template: {rotationStart?: unknown} | null | undefined,
): string => {
  const start = template?.rotationStart;
  return isDayString(start) ? start : ROTATION_EPOCH;
};

/**
 * How many occurrences fall in [anchor, day): the occurrence number of
 * `day` when it is an occurrence. Before the anchor it counts backwards
 * (negative), so turns stay in order on both sides.
 * @param {NormalizedRecurrence} recurrence The schedule.
 * @param {string} anchor Counting anchor.
 * @param {string} day Day to number.
 * @return {number} Occurrence number.
 */
export const occurrenceNumber = (
  recurrence: NormalizedRecurrence,
  anchor: string,
  day: string,
): number => {
  const span = diffDays(day, anchor);
  if (span === 0 || Math.abs(span) > MAX_SPAN_DAYS) return 0;
  const [from, to] = span > 0 ? [anchor, day] : [day, anchor];
  let count = 0;
  for (let cursor = from; cursor < to; cursor = addDays(cursor, 1)) {
    if (occursOn(cursor, recurrence)) count++;
  }
  return span > 0 ? count : -count;
};

/**
 * Whose turn occurrence number `n` is: rotation[n mod k], or the next
 * person after it who `eligible` accepts; null when nobody is.
 * @param {string[]} rotation The rotation (rotationOf).
 * @param {number} n Occurrence number.
 * @param {Function} eligible Whether a uid can be assigned now.
 * @return {string | null} The uid.
 */
export const rotationTurn = (
  rotation: readonly string[],
  n: number,
  eligible: (uid: string) => boolean,
): string | null => {
  const size = rotation.length;
  if (size === 0) return null;
  const start = ((n % size) + size) % size;
  for (let step = 0; step < size; step++) {
    const uid = rotation[(start + step) % size];
    if (eligible(uid)) return uid;
  }
  return null;
};
