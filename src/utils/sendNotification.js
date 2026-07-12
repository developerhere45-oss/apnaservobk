const { admin } = require("../config/firebase");

async function sendNotification({ token, tokens, title, body, data = {} }) {
  const cleanTokens = (tokens || (token ? [token] : [])).filter(Boolean);
  if (!cleanTokens.length) {
    return { successCount: 0, failureCount: 0 };
  }

  const messageData = {};
  for (const [key, value] of Object.entries(data)) {
    messageData[key] = value == null ? "" : String(value);
  }

  const notificationTitle = String(title || "ApnaServo");
  const notificationBody = String(body || "New update received");
  const notificationTag = messageData.bookingId || messageData.actionId || "";
  const isChat = String(messageData.actionType || "").toUpperCase() === "OPEN_BOOKING_CHAT"
    || String(messageData.type || "").toLowerCase().includes("chat");
  const notificationMessage = {
    notification: {
      title: notificationTitle,
      body: notificationBody
    },
    data: {
      ...messageData,
      title: notificationTitle,
      body: notificationBody
    },
    android: {
      priority: "high",
      notification: {
        channelId: isChat ? "booking_chat" : "booking_requests",
        sound: "default",
        ...(notificationTag ? { tag: notificationTag } : {})
      }
    },
    apns: {
      headers: {
        "apns-priority": "10"
      },
      payload: {
        aps: {
          sound: "default",
          badge: 1,
          category: isChat ? "BOOKING_CHAT" : "BOOKING_UPDATE"
        }
      }
    }
  };

  try {
    if (cleanTokens.length === 1) {
      await admin.messaging().send({
        token: cleanTokens[0],
        ...notificationMessage
      });
      return { successCount: 1, failureCount: 0 };
    }

    return await admin.messaging().sendEachForMulticast({
      tokens: cleanTokens,
      ...notificationMessage
    });
  } catch (error) {
    console.warn("FCM notification failed:", error.message);
    return { successCount: 0, failureCount: cleanTokens.length, error: error.message };
  }
}

module.exports = sendNotification;
