import {
  onDocumentCreated, onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getApp, initializeApp} from "firebase-admin/app";
import {
  FieldPath,
  FieldValue,
  getFirestore,
  Timestamp,
  type DocumentReference,
  type WriteResult,
} from "firebase-admin/firestore";
import {getMessaging, type MulticastMessage} from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";
import {
  readMemberContacts, runHouseholdReminders, sweepDeviceRevocations,
} from "./reminders";
import {getAuth} from "firebase-admin/auth";
import {getStorage} from "firebase-admin/storage";
import {resumePetDeletions, type PetPhotoBucket} from "./shared/pet-delete";
import {
  resumeMaintenanceDeletions, type MaintenanceFileBucket,
} from "./shared/maintenance-delete";
import {withContactEmails} from "./shared/member-contact";
import {
  clampText,
  isApprovedMember,
  pushOnCreate,
  pushOnUpdate,
  releasedUids,
  safeDeepLink,
  selectRecipientEmails,
  type MemberRecord,
} from "./push-policy";
import {filterRecipientsByCategory} from "./shared/push-audience";
import {pushActionsFor} from "./shared/push-actions";
import {
  pushHoldUntil, pushTtlSeconds, readLocalWindow,
} from "./shared/push-hold";
import {safeTimeZone} from "./shared/calendar";
import {releaseHeldPushes} from "./held-pushes";
import {mutesCategory, readPushPrefs} from "./shared/push-prefs";
import {
  memberCanView,
  resolvePushImage,
  webpushNotification,
  type PushImage,
} from "./shared/push-media";

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

type TokenOwner = {
  token: string;
  // Every document that holds this token: the owner-only
  // users/{email}/private/push doc and, until the migration empties it, the
  // legacy users/{email}.fcmTokens field.
  refs: DocumentReference[];
  showImage: boolean;
};

// Firestore reads for the push image. Paths are built by push-media from the
// trigger's own householdId, so reads never leave that household.
const readDoc = async (path: string) => (await db.doc(path).get()).data();

/**
 * Sends one notification document as a push to its approved recipients and
 * removes tokens FCM reports as invalid.
 * @param {string} householdId Household from the document path.
 * @param {string} notificationId Notification document ID (the push tag).
 * @param {Record<string, unknown>} notificationData The document.
 * @param {string[]} onlyUids Send only to these members (a held push
 *   released by upkeep); every addressed member when absent.
 * @return {Promise<unknown>} Settles when sending and cleanup are done.
 */
const deliverPush = async (
  householdId: string,
  notificationId: string,
  notificationData: Record<string, unknown>,
  onlyUids?: string[],
) => {
  if (notificationData.householdId !== householdId) {
    logger.warn("Notification householdId does not match its path.");
    return;
  }

  // Membership records are the only authority for who receives a push.
  const house = db.collection("households").doc(householdId);
  const membersSnap = await house.collection("members").get();
  const records: MemberRecord[] = membersSnap.docs
    .map((doc) => ({uid: doc.id, ...doc.data()}));
  // Emails come only from each approved member's contact document; any
  // legacy email on a membership record is ignored. A failed read is
  // retried briefly; if it keeps failing, readMemberContacts throws and
  // the invocation fails (logged as an error, nothing sent; neither trigger
  // has retries, so a notification is never pushed twice).
  const members = withContactEmails(records, await readMemberContacts(
    house, records.filter(isApprovedMember).map((m) => m.uid)));
  // Members who cannot see this category in the app (for example no
  // pets.view for a pets reminder) get no push at all, matching the bell.
  const uidByEmail = new Map(members.filter(isApprovedMember)
    .flatMap((m) => typeof m.email === "string" ?
      [[m.email.toLowerCase(), m.uid] as const] : []));
  const only = onlyUids ? new Set(onlyUids) : null;
  // NO-11: the person who caused it (for example the one who transferred
  // ownership) is not pushed about it; it is still in their bell.
  const creator = typeof notificationData.createdByUid === "string" ?
    notificationData.createdByUid : null;
  const addressed = filterRecipientsByCategory(
    members.filter(isApprovedMember),
    selectRecipientEmails(members, notificationData),
    notificationData.category)
    .filter((email) => {
      const uid = uidByEmail.get(email.toLowerCase()) ?? "";
      return (!only || only.has(uid)) && uid !== creator;
    });
  if (addressed.length === 0) {
    logger.log("No approved recipients for notification.");
    return;
  }

  // Each addressed member's push document (tokens and, NO-24, their own
  // preferences) and legacy profile tokens, read once.
  const addressedDocs = await Promise.all(
    addressed.map((email) => {
      const profileRef = db.collection("users").doc(email);
      return Promise.all([
        profileRef.collection("private").doc("push").get(),
        profileRef.get(),
      ]);
    }),
  );
  const docsByEmail = new Map(addressed.map((email, index) =>
    [email, addressedDocs[index]] as const));
  const prefsOf = (email: string) =>
    readPushPrefs(docsByEmail.get(email)?.[0].data()?.prefs);

  // NO-3 and household quiet hours (16.3): a push that may not be sent now
  // is recorded on the notification and sent by hourly upkeep
  // (./held-pushes.ts). NO-24: a member who muted the category gets no push,
  // and a member's own quiet hours hold theirs. The notification itself is
  // already in the bell.
  const householdData = (await house.get()).data() ?? {};
  const timeZone = safeTimeZone(householdData.timeZone);
  const audience = notificationData.audience;
  const householdWide = Array.isArray(audience) ? audience.includes("*") :
    !notificationData.targetUserUid && !notificationData.targetUserEmail;
  const now = new Date();
  const held = new Map<string, Date>();
  const recipientEmails = addressed.filter((email) => {
    const prefs = prefsOf(email);
    if (mutesCategory(prefs, notificationData.category)) return false;
    const uid = uidByEmail.get(email.toLowerCase());
    const until = uid ? pushHoldUntil({
      now, timeZone, householdWide,
      morningHold: notificationData.holdUntilMorning === true,
      householdQuiet: readLocalWindow(householdData.quietHours),
      memberQuiet: prefs.quietHours,
    }) : null;
    if (uid && until) held.set(uid, until);
    return !until;
  });
  if (held.size > 0) {
    const times = [...held.values()].map((d) => d.getTime());
    const stored = notificationData.pushHeldNext as Timestamp | undefined;
    if (stored && typeof stored.toMillis === "function") {
      times.push(stored.toMillis());
    }
    const pairs = [...held].flatMap(([uid, until]) =>
      [new FieldPath("pushHeld", uid), Timestamp.fromDate(until)]);
    await house.collection("notifications").doc(notificationId).update(
      "pushHeldNext", Timestamp.fromMillis(Math.min(...times)), ...pairs);
    logger.log("Push held for later.", {held: held.size});
  }
  if (recipientEmails.length === 0) return;

  const image: PushImage | null = await resolvePushImage(
    readDoc, householdId, notificationData,
    getApp().options.storageBucket ?? "");
  // Only recipients who could open the pet or product in the app see its
  // picture; everyone else gets the same push without the image.
  const canSeeImage = (email: string): boolean => {
    if (!image) return false;
    const lower = email.toLowerCase();
    const member = members.find((m) => isApprovedMember(m) &&
      typeof m.email === "string" && m.email.toLowerCase() === lower);
    return member ? memberCanView(member, image.permission) : false;
  };

  const tokenOwners: TokenOwner[] = [];
  recipientEmails.forEach((email) => {
    const docs = docsByEmail.get(email) ?? [];
    const showImage = canSeeImage(email);
    const byToken = new Map<string, TokenOwner>();
    for (const tokenDoc of docs) {
      const raw = tokenDoc.data()?.fcmTokens;
      const tokens: unknown[] = Array.isArray(raw) ? raw : [];
      for (const token of tokens) {
        if (typeof token !== "string") continue;
        const owner = byToken.get(token) ?? {token, refs: [], showImage};
        owner.refs.push(tokenDoc.ref);
        byToken.set(token, owner);
      }
    }
    tokenOwners.push(...byToken.values());
  });

  if (tokenOwners.length === 0) {
    logger.log("No FCM tokens found for notification recipients.");
    return;
  }

  const title = clampText(notificationData.title, "HomeHub", 120);
  const body = clampText(
    notificationData.message, "You have a new notification.", 500);
  const tag = notificationId;
  const actions = pushActionsFor(notificationData);
  const ttl = pushTtlSeconds(notificationData.holdUntilMorning === true,
    new Date(), timeZone);
  const groups = [true, false]
    .map((withImage) => tokenOwners.filter((o) => o.showImage === withImage))
    .filter((group) => group.length > 0);

  const tokensToRemove: Promise<WriteResult>[] = [];
  for (const group of groups) {
    const options = webpushNotification(
      tag, group[0].showImage && image ? image.url : null);
    const payload: MulticastMessage = {
      notification: {title, body},
      webpush: {
        headers: {TTL: String(ttl)},
        fcmOptions: {link: safeDeepLink(notificationData.deepLink)},
        notification: options,
        // The service worker's own display reads these (the SDK does not
        // pass badge or tag through to onBackgroundMessage). NO-23: action
        // buttons that open in-app links; the worker re-checks them.
        data: {
          tag: options.tag, badge: options.badge,
          ...(actions.length > 0 ? {actions: JSON.stringify(actions)} : {}),
        },
      },
      tokens: group.map((entry) => entry.token),
    };

    const response = await messaging.sendEachForMulticast(payload);
    logger.log("Push notification send completed.", {
      successCount: response.successCount,
      failureCount: response.failureCount,
      withImage: Boolean(options.image),
    });

    response.responses.forEach((result, index) => {
      const error = result.error;
      if (result.success || !error) return;
      logger.error("Failure sending notification.", {code: error.code});
      if (
        error.code === "messaging/invalid-registration-token" ||
        error.code === "messaging/registration-token-not-registered"
      ) {
        for (const ref of group[index].refs) {
          tokensToRemove.push(ref.update({
            fcmTokens: FieldValue.arrayRemove(
              group[index].token),
          }));
        }
      }
    });
  }

  return Promise.all(tokensToRemove);
};

export const sendPushOnNewNotification = onDocumentCreated(
  "households/{householdId}/notifications/{notificationId}",
  async (event) => {
    const notificationData = event.data?.data();
    if (!notificationData) {
      logger.log("No data in notification, exiting.");
      return;
    }
    if (!pushOnCreate(notificationData)) {
      logger.log("Notification created silently.");
      return;
    }
    return deliverPush(event.params.householdId, event.params.notificationId,
      notificationData);
  },
);

// A notification updated in place is pushed again only when upkeep asks for
// it (`renotifyAt` moved): the per-person overdue notification when a chore
// the person was not told about becomes overdue. Every other update (read,
// dismiss, refresh, resolve) returns at once.
export const sendPushOnRenotify = onDocumentUpdated(
  "households/{householdId}/notifications/{notificationId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (pushOnUpdate(before, after)) {
      return deliverPush(event.params.householdId,
        event.params.notificationId, after);
    }
    // A held push whose time has come (released by hourly upkeep).
    const uids = releasedUids(before, after);
    if (uids.length === 0) return;
    return deliverPush(event.params.householdId, event.params.notificationId,
      after, uids);
  },
);

// Hourly upkeep for every household: maintenance and chore reminders, the
// next recurring chores, and finishing interrupted pet deletes. Runs without
// anyone opening the app. Each household is isolated so one failure is
// logged and never blocks the others.
export const householdUpkeep = onSchedule(
  {schedule: "every 60 minutes", timeZone: "UTC", retryCount: 0},
  async () => {
    const now = new Date();
    const ts = (d: Date) => Timestamp.fromDate(d);
    const households = await db.collection("households").select().get();
    const totals = {households: 0, failed: 0, generatedChores: 0,
      purgedChores: 0, expiredChores: 0, createdNotifications: 0,
      refreshedNotifications: 0,
      resolvedNotifications: 0, reopenedNotifications: 0};
    for (const household of households.docs) {
      try {
        const result = await runHouseholdReminders(db, household.id, now, ts);
        // Pushes held for the morning or for quiet hours whose time has come.
        await releaseHeldPushes(db, household.ref, now, ts);
        totals.households++;
        totals.generatedChores += result.generatedChores;
        totals.purgedChores += result.purgedChores;
        totals.expiredChores += result.expiredChores;
        totals.createdNotifications += result.createdNotifications;
        totals.refreshedNotifications += result.refreshedNotifications;
        totals.resolvedNotifications += result.resolvedNotifications;
        totals.reopenedNotifications += result.reopenedNotifications;
      } catch (error) {
        totals.failed++;
        logger.error("Household upkeep failed.", {
          householdId: household.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Daily: finish the sign-out of removed, unpaired or re-paired wall
    // tablets (docs/modules/devices/README.md). Isolated like a household.
    try {
      const sweep = await sweepDeviceRevocations(db, getAuth(), now);
      if (sweep.ran) logger.info("Wall-tablet sign-out sweep finished.", sweep);
      if (sweep.failed > 0) totals.failed++;
    } catch (error) {
      totals.failed++;
      logger.error("Wall-tablet sign-out sweep failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Finish any pet delete that stopped after its pet was gone (its
    // tombstone is still there): histories, photos and reminders
    // (docs/modules/pets/README.md). Isolated like a household.
    try {
      const bucket = getApp().options.storageBucket ?
        getStorage().bucket() as unknown as PetPhotoBucket : null;
      const pets = await resumePetDeletions(db, bucket, now, ts,
        (path, error) => logger.error("Resuming a pet delete failed.", {
          path, error: error instanceof Error ? error.message : String(error),
        }));
      if (pets.found > 0) logger.info("Pet delete resume finished.", pets);
      if (pets.failed > 0) totals.failed++;
    } catch (error) {
      totals.failed++;
      logger.error("Pet delete resume failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Finish any maintenance delete (asset, vehicle or log with its files)
    // that stopped after its record was gone: logs kept as history, files,
    // reminders (docs/modules/maintenance-center/README.md).
    try {
      const bucket = getApp().options.storageBucket ?
        getStorage().bucket() as unknown as MaintenanceFileBucket : null;
      const records = await resumeMaintenanceDeletions(db, bucket, now, ts,
        FieldValue.delete(),
        (path, error) => logger.error("Resuming a maintenance delete failed.", {
          path, error: error instanceof Error ? error.message : String(error),
        }));
      if (records.found > 0) {
        logger.info("Maintenance delete resume finished.", records);
      }
      if (records.failed > 0) totals.failed++;
    } catch (error) {
      totals.failed++;
      logger.error("Maintenance delete resume failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info("Household upkeep finished.", totals);
    if (totals.failed > 0) {
      // Surface partial failure in Error Reporting without retrying the rest.
      logger.error("Household upkeep had failures.", {failed: totals.failed});
    }
  },
);
