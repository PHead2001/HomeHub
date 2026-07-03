
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

export const sendPushOnNewNotification = onDocumentCreated(
  "households/{householdId}/notifications/{notificationId}",
  async (event) => {
    const {householdId} = event.params;
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

    const recipientRefs: admin.firestore.DocumentReference[] = [];
    const targetUserEmail = notificationData.targetUserEmail;
    const targetUserUid = notificationData.targetUserUid;

    if (typeof targetUserEmail === "string") {
      recipientRefs.push(db.collection("users").doc(targetUserEmail));
    } else if (typeof targetUserUid === "string") {
      const userQuery = await db
        .collection("users")
        .where("uid", "==", targetUserUid)
        .limit(1)
        .get();
      userQuery.docs.forEach((doc) => recipientRefs.push(doc.ref));
    } else {
      const householdDoc = await db.collection("households").doc(householdId).get();
      const householdData = householdDoc.data();
      const memberEmails = Array.isArray(householdData?.memberEmails) ?
        householdData.memberEmails :
        [];

      memberEmails.forEach((email) => {
        if (typeof email === "string") {
          recipientRefs.push(db.collection("users").doc(email));
        }
      });
    }

    const recipientDocs = await Promise.all(recipientRefs.map((ref) => ref.get()));
    const tokenOwners: {token: string; ref: admin.firestore.DocumentReference}[] = [];

    recipientDocs.forEach((userDoc) => {
      const userData = userDoc.data();
      const tokens = Array.isArray(userData?.fcmTokens) ? userData.fcmTokens : [];

      tokens.forEach((token) => {
        if (typeof token === "string") {
          tokenOwners.push({token, ref: userDoc.ref});
        }
      });
    });

    if (tokenOwners.length === 0) {
      logger.log("No FCM tokens found for notification recipient.");
      return;
    }

    const tokens = tokenOwners.map((entry) => entry.token);

    const payload: admin.messaging.MulticastMessage = {
      notification: {
        title: notificationData.title || "HomeHub",
        body: notificationData.message || "You have a new notification.",
      },
      webpush: {
        fcmOptions: {
          link: notificationData.deepLink || notificationData.href || "/",
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
            const invalidToken = tokenOwners[index].token;
            const invalidTokenOwner = tokenOwners[index].ref;
            tokensToRemove.push(
              invalidTokenOwner.update({
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
