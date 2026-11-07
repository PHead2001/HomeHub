import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {runHouseholdReminders} from "./reminders";
import {
  clampText,
  isApprovedMember,
  safeDeepLink,
  selectRecipientEmails,
  type MemberRecord,
} from "./push-policy";
import {
  memberCanView,
  resolvePushImage,
  webpushNotification,
  type PushImage,
} from "./shared/push-media";

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

type TokenOwner = {
  token: string;
  ref: admin.firestore.DocumentReference;
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
    const membersSnap = await db.collection("households").doc(householdId)
      .collection("members").get();
    const members: MemberRecord[] = membersSnap.docs
      .map((doc) => ({uid: doc.id, ...doc.data()}));
    const recipientEmails = selectRecipientEmails(members, notificationData);
    if (recipientEmails.length === 0) {
      logger.log("No approved recipients for notification.");
      return;
    }

    const image: PushImage | null = await resolvePushImage(
      readDoc, householdId, notificationData,
      admin.app().options.storageBucket ?? "");
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
      recipientEmails.map((email) => db.collection("users").doc(email).get()),
    );
    const tokenOwners: TokenOwner[] = [];
    recipientDocs.forEach((userDoc, index) => {
      const raw = userDoc.data()?.fcmTokens;
      const tokens: unknown[] = Array.isArray(raw) ? raw : [];
      const showImage = canSeeImage(recipientEmails[index]);
      tokens.forEach((token) => {
        if (typeof token === "string") {
          tokenOwners.push({token, ref: userDoc.ref, showImage});
        }
      });
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

    const tokensToRemove: Promise<admin.firestore.WriteResult>[] = [];
    for (const group of groups) {
      const options = webpushNotification(
        tag, group[0].showImage && image ? image.url : null);
      const payload: admin.messaging.MulticastMessage = {
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
          tokensToRemove.push(group[index].ref.update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(
              group[index].token),
          }));
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
    const ts = (d: Date) => admin.firestore.Timestamp.fromDate(d);
    const households = await db.collection("households").select().get();
    const totals = {households: 0, failed: 0, generatedChores: 0,
      purgedChores: 0, createdNotifications: 0, refreshedNotifications: 0};
    for (const household of households.docs) {
      try {
        const result = await runHouseholdReminders(db, household.id, now, ts);
        totals.households++;
        totals.generatedChores += result.generatedChores;
        totals.purgedChores += result.purgedChores;
        totals.createdNotifications += result.createdNotifications;
        totals.refreshedNotifications += result.refreshedNotifications;
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
