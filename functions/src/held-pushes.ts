// Sends pushes that were held (NO-3, NO-24; ./shared/push-hold.ts) once
// their time has come. Called by hourly upkeep for each household. A held
// push is recorded on its notification by the push function:
// `pushHeld.<uid>` (when it may be sent) and `pushHeldNext` (the earliest
// of them, the field this query uses). Releasing writes `pushRelease`
// `{at, uids}`; the update trigger sends to exactly those members
// (`releasedUids` in ./push-policy.ts). Clients can write none of these
// fields (the rules allow them only their own read and dismiss entries).
import type {
  DocumentReference, Firestore,
  Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import {releaseHeld} from "./shared/push-hold";
import {deterministicNotificationId} from "./shared/ids";
import {MEDICATION_SOURCE_TYPE} from "./shared/medication-reminders";

/**
 * The overdue state that supersedes a medication reminder's "due" state for
 * the same dose (its state key with `overdue` in place of `due`), or null.
 * Both are pending for the same occurrence, so a held "due" push is dropped
 * once the overdue reminder exists: one push per dose, never two at 07:00.
 * @param {unknown} sourceType The held notification's source type.
 * @param {unknown} stateKey Its state key.
 * @return {string | null} The superseding state key, or null.
 */
export const supersedingStateKey = (
  sourceType: unknown, stateKey: unknown,
): string | null => sourceType === MEDICATION_SOURCE_TYPE &&
  typeof stateKey === "string" && stateKey.startsWith("due|") ?
  `overdue|${stateKey.slice("due|".length)}` : null;

type Timestamp = FirestoreTimestamp;

const millisOf = (value: unknown): number | null => {
  if (value && typeof value === "object" &&
      typeof (value as Timestamp).toMillis === "function") {
    return (value as Timestamp).toMillis();
  }
  return null;
};

/**
 * The held entries of a notification, uid → epoch ms.
 * @param {unknown} value Stored `pushHeld`.
 * @return {Record<string, number>} Entries with a readable time.
 */
export const heldEntries = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, number> = {};
  for (const [uid, at] of Object.entries(value as Record<string, unknown>)) {
    const ms = millisOf(at);
    if (ms !== null) entries[uid] = ms;
  }
  return entries;
};

const keysOf = (value: unknown): string[] =>
  value && typeof value === "object" ? Object.keys(value) : [];

/**
 * Releases every held push of this household whose time has come.
 * @param {Firestore} db Firestore (Admin SDK).
 * @param {DocumentReference} house Household document.
 * @param {Date} now Current instant.
 * @param {Function} ts Converts a Date to a Firestore Timestamp.
 * @return {Promise<number>} Notifications released.
 */
export const releaseHeldPushes = async (
  db: Firestore,
  house: DocumentReference,
  now: Date,
  ts: (d: Date) => Timestamp,
): Promise<number> => {
  const due = await house.collection("notifications")
    .where("pushHeldNext", "<=", ts(now)).limit(200).get();
  let released = 0;
  for (const note of due.docs) {
    const sent = await db.runTransaction(async (tx) => {
      const later = supersedingStateKey(note.get("sourceType"),
        note.get("stateKey"));
      const sourceId = note.get("sourceId");
      const laterRef = later && typeof sourceId === "string" ?
        house.collection("notifications").doc(deterministicNotificationId(
          MEDICATION_SOURCE_TYPE, sourceId, later)) : null;
      const [home, snap, laterSnap] = await Promise.all([tx.get(house),
        tx.get(note.ref), laterRef ? tx.get(laterRef) : Promise.resolve(null)]);
      if (!home.exists || home.get("deletingAt") || !snap.exists) {
        return false;
      }
      // An overdue reminder for the same dose took over: drop this push.
      const superseded = Boolean(laterSnap?.exists);
      const expires = millisOf(snap.get("expiresAt"));
      const seenBy = new Set([...keysOf(snap.get("readBy")),
        ...keysOf(snap.get("dismissedBy"))]);
      const split = releaseHeld(heldEntries(snap.get("pushHeld")),
        now.getTime(), {
          closed: superseded || Boolean(snap.get("resolvedAt")) ||
            (expires !== null && expires <= now.getTime()),
          seenBy,
        });
      const remaining: Record<string, Timestamp> = {};
      for (const [uid, at] of Object.entries(split.remaining)) {
        remaining[uid] = ts(new Date(at));
      }
      tx.update(note.ref, {
        pushHeld: remaining,
        pushHeldNext: split.next === null ? null : ts(new Date(split.next)),
        ...(split.release.length > 0 ?
          {pushRelease: {at: ts(now), uids: split.release}} : {}),
      });
      return split.release.length > 0;
    });
    if (sent) released++;
  }
  return released;
};
