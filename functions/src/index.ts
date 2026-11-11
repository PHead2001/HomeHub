import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getApp, initializeApp} from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  Timestamp,
  type DocumentReference,
  type WriteResult,
} from "firebase-admin/firestore";
import {getMessaging, type MulticastMessage} from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";
import {readMemberContacts, runHouseholdReminders} from "./reminders";
import {withContactEmails} from "./shared/member-contact";
import {
  clampText,
  isApprovedMember,
  safeDeepLink,
  selectRecipientEmails,
  type MemberRecord,
} from "./push-policy";
import {filterRecipientsByCategory} from "./shared/push-audience";
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

export const sendPushOnNewNotification = onDocumentCreated(
  "households/{householdId}/notifications/{notificationId}",
  async (event) => {
    const {householdId} = event.params;
    const notificationData = event.data?.data();
    if (!notificationData) {
      logger.log("No data in notification, exiting.");
      return;
    }
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
    // legacy email on a membership record is ignored.
    const members = withContactEmails(records, await readMemberContacts(
      house, records.filter(isApprovedMember).map((m) => m.uid)));
    // Members who cannot see this category in the app (for example no
    // pets.view for a pets reminder) get no push at all, matching the bell.
    const recipientEmails = filterRecipientsByCategory(
      members.filter(isApprovedMember),
      selectRecipientEmails(members, notificationData),
      notificationData.category);
    if (recipientEmails.length === 0) {
      logger.log("No approved recipients for notification.");
      return;
    }

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

    const recipientDocs = await Promise.all(
      recipientEmails.map((email) => {
        const profileRef = db.collection("users").doc(email);
        return Promise.all([
          profileRef.collection("private").doc("push").get(),
          profileRef.get(),
        ]);
      }),
    );
    const tokenOwners: TokenOwner[] = [];
    recipientDocs.forEach((docs, index) => {
      const showImage = canSeeImage(recipientEmails[index]);
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
    const tag = event.params.notificationId;
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
          fcmOptions: {link: safeDeepLink(notificationData.deepLink)},
          notification: options,
          // The service worker's own display reads these (the SDK does not
          // pass badge or tag through to onBackgroundMessage).
          data: {tag: options.tag, badge: options.badge},
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
  },
);

// Hourly upkeep for every household: maintenance and chore reminders, and the
// next recurring chores. Runs without anyone opening the app. Each household is
// isolated so one failure is logged and never blocks the others.
export const householdUpkeep = onSchedule(
  {schedule: "every 60 minutes", timeZone: "UTC", retryCount: 0},
  async () => {
    const now = new Date();
    const ts = (d: Date) => Timestamp.fromDate(d);
    const households = await db.collection("households").select().get();
    const totals = {households: 0, failed: 0, generatedChores: 0,
      purgedChores: 0, createdNotifications: 0, refreshedNotifications: 0,
      resolvedNotifications: 0, reopenedNotifications: 0};
    for (const household of households.docs) {
      try {
        const result = await runHouseholdReminders(db, household.id, now, ts);
        totals.households++;
        totals.generatedChores += result.generatedChores;
        totals.purgedChores += result.purgedChores;
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
    logger.info("Household upkeep finished.", totals);
    if (totals.failed > 0) {
      // Surface partial failure in Error Reporting without retrying the rest.
      logger.error("Household upkeep had failures.", {failed: totals.failed});
    }
  },
);
