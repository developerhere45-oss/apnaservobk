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
  const targetApp = String(messageData.targetApp || messageData.target_app || "").toLowerCase();
  const category = String(messageData.category || "").toLowerCase();
  const eventType = String(messageData.type || "").toLowerCase();
  const isPartnerBookingRequest = targetApp === "partner"
    && (category === "booking_request"
      || category === "emergency_booking"
      || eventType.includes("new_request")
      || eventType.includes("emergency_request"));
  // This must stay identical to PartnerBookingActionReceiver.CHANNEL_BOOKING_REQUESTS.
  // Android handles notification+data messages itself while the app is backgrounded
  // or swiped away, so a mismatched channel silently bypasses the app's booking ring.
  const androidChannelId = isPartnerBookingRequest
    ? "partner_booking_requests_call_v4"
    : (isChat ? "booking_chat" : "booking_requests");
  const androidSound = isPartnerBookingRequest ? "incoming_booking_ring" : "default";
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
      ttl: 10 * 60 * 1000,
      notification: {
        channelId: androidChannelId,
        sound: androidSound,
        priority: isPartnerBookingRequest ? "max" : "high",
        visibility: "public",
        defaultVibrateTimings: true,
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
