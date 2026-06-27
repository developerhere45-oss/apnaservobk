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

  try {
    if (cleanTokens.length === 1) {
      await admin.messaging().send({
        token: cleanTokens[0],
        data: { ...messageData, title: String(title || "ApnaServo"), body: String(body || "New update received") },
        android: {
          priority: "high",
          notification: {
            channelId: "booking_requests",
            sound: "default"
          }
        }
      });
      return { successCount: 1, failureCount: 0 };
    }

    return await admin.messaging().sendEachForMulticast({
      tokens: cleanTokens,
      data: { ...messageData, title: String(title || "ApnaServo"), body: String(body || "New update received") },
      android: {
        priority: "high",
        notification: {
          channelId: "booking_requests",
          sound: "default"
        }
      }
    });
  } catch (error) {
    console.warn("FCM notification failed:", error.message);
    return { successCount: 0, failureCount: cleanTokens.length, error: error.message };
  }
}

module.exports = sendNotification;
