const InAppNotification = require("../models/InAppNotification");
const SmsDeliveryLog = require("../models/SmsDeliveryLog");
const sendNotification = require("./sendNotification");

function pushData(data = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(data || {})) {
    clean[key] = value == null ? "" : String(value);
  }
  return clean;
}

function notificationOwner(recipient = {}) {
  return {
    recipientRole: recipient.role || recipient.recipientRole || "user",
    userId: recipient.userId || null,
    partnerId: recipient.partnerId || null,
    recipientFirebaseUid: recipient.firebaseUid || ""
  };
}

function boundedConcurrency() {
  const value = Number(process.env.NOTIFICATION_CONCURRENCY || 8);
  return Number.isFinite(value) && value >= 1 && value <= 50 ? Math.floor(value) : 8;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function sendSmsBackup({ notification, recipient, smsBody }) {
  if (!smsBody || !recipient?.phone) {
    return { status: "skipped", logId: null };
  }

  const providerUrl = String(process.env.SMS_PROVIDER_URL || "").trim();
  const authHeader = String(process.env.SMS_PROVIDER_AUTH || "").trim();
  const provider = providerUrl ? new URL(providerUrl).hostname : "";

  const log = await SmsDeliveryLog.create({
    notificationId: notification._id,
    ...notificationOwner(recipient),
    phone: recipient.phone,
    body: smsBody,
    provider: provider || "unconfigured",
    status: providerUrl ? "skipped" : "not_configured"
  });

  if (!providerUrl) {
    return { status: "not_configured", logId: log._id };
  }

  try {
    const response = await fetch(providerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {})
      },
      body: JSON.stringify({
        to: recipient.phone,
        from: process.env.SMS_FROM || "ApnaServo",
        message: smsBody,
        notificationId: String(notification._id)
      }),
      signal: AbortSignal.timeout(8000)
    });
    const text = await response.text();
    log.status = response.ok ? "sent" : "failed";
    log.responseCode = response.status;
    log.responseBody = text.slice(0, 1000);
    if (!response.ok) {
      log.error = `SMS provider HTTP ${response.status}`;
    }
    await log.save();
    return { status: log.status, logId: log._id };
  } catch (error) {
    log.status = "failed";
    log.error = error.message;
    await log.save();
    return { status: "failed", logId: log._id };
  }
}

async function notifyOne({ recipient, title, body, cleanData, type, category, priority, smsBody }) {
  const notification = await InAppNotification.create({
    ...notificationOwner(recipient),
    title,
    body,
    type: cleanData.type || type,
    category,
    priority,
    data: cleanData,
    bookingId: cleanData.bookingId || null,
    bookingCode: cleanData.bookingCode || "",
    pushStatus: recipient.token ? "pending" : "skipped"
  });

  let pushResult = { successCount: 0, failureCount: recipient.token ? 1 : 0 };
  if (recipient.token) {
    pushResult = await sendNotification({
      token: recipient.token,
      title,
      body,
      data: cleanData
    });
    notification.pushSuccessCount = Number(pushResult.successCount || 0);
    notification.pushFailureCount = Number(pushResult.failureCount || 0);
    notification.pushError = pushResult.error || "";
    notification.pushStatus = notification.pushSuccessCount > 0 ? "sent" : "failed";
  }

  if (!recipient.token) {
    notification.pushStatus = "skipped";
  }

  if (notification.pushSuccessCount < 1) {
    const sms = await sendSmsBackup({ notification, recipient, smsBody });
    notification.smsStatus = sms.status;
    notification.smsLogId = sms.logId;
  }

  await notification.save();
  return {
    notificationId: notification._id,
    pushStatus: notification.pushStatus,
    pushSuccessCount: notification.pushSuccessCount,
    smsStatus: notification.smsStatus
  };
}

async function reliableNotify({ recipients = [], title, body, data = {}, type = "system", category = "system", priority = "normal", smsBody = "" }) {
  const cleanRecipients = recipients.filter(Boolean);
  const cleanData = pushData(data);
  const results = await mapLimit(
    cleanRecipients,
    boundedConcurrency(),
    (recipient) => notifyOne({ recipient, title, body, cleanData, type, category, priority, smsBody })
  );

  return {
    ok: true,
    attempted: results.length,
    results
  };
}

module.exports = {
  reliableNotify
};
