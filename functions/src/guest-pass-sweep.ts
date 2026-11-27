// Hourly removal of guest passes that have ended (audit HO-14, HO-24; see
// docs/modules/household-governance/README.md, "Guest passes"). An ended
// pass already grants nothing (rules, server actions, push); this removes the
// record without anyone opening the app, as the Household page's
// expireGuestPassesAction also does. One transaction per record, which
// re-reads it and removes it only if its pass has still ended.

import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
} from "firebase-admin/firestore";
import {unassignedChoreFields} from "./shared/assignee";
import {guestPassCurrent} from "./push-policy";

/**
 * Removes every membership record of a household whose guest pass ended.
 * Accounts lose their record, contact and PIN documents, tablet PIN state,
 * profile pointer and open chores and templates; tablet passes (guest_
 * identities) their record and open chores. Logged as
 * member.guest_pass_ended with no person as the actor.
 * @param {Firestore} db Firestore (Admin SDK).
 * @param {string} householdId Household to sweep.
 * @param {Date} now Current instant.
 * @return {Promise<number>} How many passes were removed.
 */
export const sweepEndedGuestPasses = async (
  db: Firestore,
  householdId: string,
  now: Date,
): Promise<number> => {
  const house = db.collection("households").doc(householdId);
  const ended = await house.collection("members")
    .where("accessUntil", "<=", Timestamp.fromDate(now)).get();
  let removed = 0;
  for (const candidate of ended.docs) {
    const done = await db.runTransaction(async (tx) => {
      const uid = candidate.id;
      const memberRef = candidate.ref;
      const contactRef = memberRef.collection("private").doc("contact");
      const [home, member, contact] =
        await tx.getAll(house, memberRef, contactRef);
      if (!home.exists || home.get("deletingAt")) return false;
      if (!member.exists) return false;
      if (guestPassCurrent(member.get("accessUntil"), now.getTime())) {
        return false;
      }
      const email = contact.exists && typeof contact.get("email") === "string" ?
        contact.get("email") as string : "";
      const profileRef = email ? db.collection("users").doc(email) : null;
      const devices = await tx.get(house.collection("devices"));
      const [profile, chores, templates, sessions, guards] = await Promise.all([
        profileRef ? tx.get(profileRef) : Promise.resolve(null),
        tx.get(house.collection("chores")
          .where("assignedToUid", "==", uid)
          .where("isCompleted", "==", false)),
        tx.get(house.collection("chore-templates")
          .where("assignedToUid", "==", uid)),
        Promise.all(devices.docs.map((d) => tx.get(
          d.ref.collection("pinSessions").where("memberUid", "==", uid)))),
        Promise.all(devices.docs.map((d) =>
          tx.get(d.ref.collection("pinGuards").doc(uid)))),
      ]);
      const iso = now.toISOString();
      const deletions: DocumentReference[] = [
        memberRef,
        contactRef,
        memberRef.collection("private").doc("pin"),
        memberRef.collection("private").doc("pinGuard"),
        ...sessions.flatMap((s) => s.docs.map((d) => d.ref)),
        ...guards.filter((g: DocumentSnapshot) => g.exists).map((g) => g.ref),
      ];
      deletions.forEach((ref) => tx.delete(ref));
      if (profileRef && profile?.exists &&
        profile.get("householdId") === householdId) {
        tx.set(profileRef,
          {householdId: null, role: "member", permissions: {}},
          {merge: true});
      }
      chores.docs.forEach((d) => tx.update(d.ref, {
        ...unassignedChoreFields(),
        assignedToEmail: FieldValue.delete(),
      }));
      templates.docs.forEach((d) => tx.update(d.ref, {
        assignedToUid: FieldValue.delete(),
        assignedToEmail: FieldValue.delete(),
        ...(d.get("recurrence") && typeof d.get("recurrence") === "object" ?
          {"recurrence.assignedToEmail": FieldValue.delete()} : {}),
      }));
      tx.update(house, {updatedAt: iso});
      const until = member.get("accessUntil");
      const untilMs = until && typeof until.toMillis === "function" ?
        until.toMillis() : null;
      tx.set(house.collection("auditLogs").doc(), {
        actorUid: null,
        actorEmail: null,
        actorName: null,
        action: "member.guest_pass_ended",
        targetUid: uid,
        targetEmail: email || null,
        targetName: typeof member.get("displayName") === "string" ?
          member.get("displayName") : null,
        createdAt: iso,
        details: {
          accessUntil: untilMs === null ?
            null : new Date(untilMs).toISOString(),
          tablet: member.get("kind") === "identity",
          by: "upkeep",
        },
      });
      return true;
    });
    if (done) removed++;
  }
  return removed;
};
