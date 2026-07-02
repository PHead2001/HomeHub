
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

export const sendPushOnNewNotification = onDocumentCreated(
  "users/{userEmail}/notifications/{notificationId}",
  async (event) => {
    const {userEmail} = event.params;
    const snapshot = event.data;

    if (!snapshot) {
      logger.log("No data associated with the event, exiting.");
      return;
    }
    const notificationData = snapshot.data();

    if (!notificationData) {
      logger.log("No data in notification, exiting.");
      return;
    }

    logger.log("New notification created; attempting to send push.");

    const userDocRef = db.collection("users").doc(userEmail);
    const userDoc = await userDocRef.get();
    const userData = userDoc.data();

    if (!userData || !userData.fcmTokens || userData.fcmTokens.length === 0) {
      logger.log("No FCM tokens found for notification recipient.");
      return;
    }

    const tokens: string[] = userData.fcmTokens;

    const payload: admin.messaging.MulticastMessage = {
      notification: {
        title: "HomeHub",
        body: notificationData.message || "You have a new notification.",
      },
      webpush: {
        fcmOptions: {
          link: notificationData.href || "/",
        },
        notification: {
          icon: "/favicon.ico",
        },
      },
      tokens: tokens,
    };

    const response = await messaging.sendEachForMulticast(payload);

    logger.log("Push notification send completed.", {
      successCount: response.successCount,
      failureCount: response.failureCount,
    });

    const tokensToRemove: Promise<admin.firestore.WriteResult>[] = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        const error = result.error;
        if (error) {
          logger.error(
            "Failure sending notification.",
            {code: error.code},
          );
          if (
            error.code === "messaging/invalid-registration-token" ||
            error.code === "messaging/registration-token-not-registered"
          ) {
            const invalidToken = tokens[index];
            tokensToRemove.push(
              userDocRef.update({
                fcmTokens: admin.firestore.FieldValue.arrayRemove(invalidToken),
              }),
            );
          }
        }
      }
    });

    return Promise.all(tokensToRemove);
  },
);
