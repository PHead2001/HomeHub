import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {
  clampText,
  safeDeepLink,
  selectRecipientEmails,
  type MemberRecord,
} from "./push-policy";

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

type TokenOwner = {token: string; ref: admin.firestore.DocumentReference};

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

    const recipientDocs = await Promise.all(
      recipientEmails.map((email) => db.collection("users").doc(email).get()),
    );
    const tokenOwners: TokenOwner[] = [];
    recipientDocs.forEach((userDoc) => {
      const raw = userDoc.data()?.fcmTokens;
      const tokens: unknown[] = Array.isArray(raw) ? raw : [];
      tokens.forEach((token) => {
        if (typeof token === "string") {
          tokenOwners.push({token, ref: userDoc.ref});
        }
      });
    });

    if (tokenOwners.length === 0) {
      logger.log("No FCM tokens found for notification recipients.");
      return;
    }

    const payload: admin.messaging.MulticastMessage = {
      notification: {
        title: clampText(notificationData.title, "HomeHub", 120),
        body: clampText(
          notificationData.message, "You have a new notification.", 500),
      },
      webpush: {
        fcmOptions: {link: safeDeepLink(notificationData.deepLink)},
        notification: {icon: "/favicon.ico"},
      },
      tokens: tokenOwners.map((entry) => entry.token),
    };

    const response = await messaging.sendEachForMulticast(payload);
    logger.log("Push notification send completed.", {
      successCount: response.successCount,
      failureCount: response.failureCount,
    });

    const tokensToRemove: Promise<admin.firestore.WriteResult>[] = [];
    response.responses.forEach((result, index) => {
      const error = result.error;
      if (result.success || !error) return;
      logger.error("Failure sending notification.", {code: error.code});
      if (
        error.code === "messaging/invalid-registration-token" ||
        error.code === "messaging/registration-token-not-registered"
      ) {
        tokensToRemove.push(tokenOwners[index].ref.update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(
            tokenOwners[index].token),
        }));
      }
    });

    return Promise.all(tokensToRemove);
  },
);
