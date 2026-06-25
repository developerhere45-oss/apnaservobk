const mongoose = require("mongoose");
const { admin } = require("../config/firebase");
const AdminNotification = require("../models/AdminNotification");
const InAppNotification = require("../models/InAppNotification");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { activeDeviceTokens, tokenHash } = require("./notificationTokens");
const { emitAdminEvent } = require("../sockets/bookingSocket");

const FCM_BATCH_SIZE = 500;
const INSERT_BATCH_SIZE = 1000;
const INVALID_FCM_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument"
]);

function objectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || "")) ? new mongoose.Types.ObjectId(String(value)) : null;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function cleanData(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) out[key] = value == null ? "" : String(value);
  return out;
}

function targetAppFor(notification) {
  return notification.targetType === "ALL_PARTNERS" || notification.targetType === "SPECIFIC_PARTNER" ? "PARTNER" : "USER";
}

function dataPayload(notification, targetApp) {
  return cleanData({
    type: "ADMIN_NOTIFICATION",
    notificationId: String(notification._id),
    targetApp,
    actionType: notification.actionType || "NONE",
    actionId: notification.actionId || "",
    imageUrl: notification.imageUrl || "",
    title: notification.title,
    body: notification.message
  });
}

async function resolveRecipients(notification) {
  if (notification.targetType === "ALL_USERS") {
    const users = await User.find({ accountStatus: { $nin: ["blocked", "deleted"] } })
      .select("_id firebaseUid name phone email fcmToken deviceTokens accountStatus")
      .sort({ createdAt: -1 });
    return users.map((user) => ({ role: "user", owner: user }));
  }
  if (notification.targetType === "ALL_PARTNERS") {
    const partners = await Partner.find({ accountStatus: { $nin: ["deleted"] }, trustStatus: { $ne: "suspended" } })
      .select("_id firebaseUid name phone email fcmToken deviceTokens accountStatus trustStatus")
      .sort({ createdAt: -1 });
    return partners.map((partner) => ({ role: "partner", owner: partner }));
  }
  if (notification.targetType === "SPECIFIC_USER") {
    const ids = (notification.targetUserIds || []).map(objectId).filter(Boolean);
    const users = ids.length
      ? await User.find({ _id: { $in: ids } }).select("_id firebaseUid name phone email fcmToken deviceTokens accountStatus")
      : [];
    return users.map((user) => ({ role: "user", owner: user }));
  }
  if (notification.targetType === "SPECIFIC_PARTNER") {
    const ids = (notification.targetPartnerIds || []).map(objectId).filter(Boolean);
    const partners = ids.length
      ? await Partner.find({ _id: { $in: ids } }).select("_id firebaseUid name phone email fcmToken deviceTokens accountStatus trustStatus")
      : [];
    return partners.map((partner) => ({ role: "partner", owner: partner }));
  }
  return [];
}

async function createInAppRecords(notification, recipients, targetApp) {
  const docs = recipients.map(({ role, owner }) => ({
    recipientRole: role,
    userId: role === "user" ? owner._id : null,
    partnerId: role === "partner" ? owner._id : null,
    recipientFirebaseUid: owner.firebaseUid || "",
    adminNotificationId: notification._id,
    title: notification.title,
    body: notification.message,
    imageUrl: notification.imageUrl || "",
    actionType: notification.actionType || "NONE",
    actionId: notification.actionId || "",
    type: "ADMIN_NOTIFICATION",
    category: targetApp === "PARTNER" ? "partner_admin" : "admin_announcement",
    priority: "normal",
    data: dataPayload(notification, targetApp),
    pushStatus: "pending"
  }));
  for (const batch of chunk(docs, INSERT_BATCH_SIZE)) {
    if (batch.length) await InAppNotification.insertMany(batch, { ordered: false });
  }
}

async function deactivateInvalidTokens(invalidTokens) {
  const hashes = invalidTokens.map((entry) => entry.tokenHash).filter(Boolean);
  const plainTokens = invalidTokens.map((entry) => entry.token).filter(Boolean);
  if (!hashes.length && !plainTokens.length) return;
  const now = new Date();
  await Promise.all([
    hashes.length ? User.updateMany(
      { "deviceTokens.tokenHash": { $in: hashes } },
      { $set: { "deviceTokens.$[device].isActive": false, "deviceTokens.$[device].lastUpdatedAt": now } },
      { arrayFilters: [{ "device.tokenHash": { $in: hashes } }] }
    ) : null,
    hashes.length ? Partner.updateMany(
      { "deviceTokens.tokenHash": { $in: hashes } },
      { $set: { "deviceTokens.$[device].isActive": false, "deviceTokens.$[device].lastUpdatedAt": now } },
      { arrayFilters: [{ "device.tokenHash": { $in: hashes } }] }
    ) : null,
    ...plainTokens.map((token) => User.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } })),
    ...plainTokens.map((token) => Partner.updateMany({ fcmToken: token }, { $set: { fcmToken: "" } }))
  ].filter(Boolean));
}

async function sendFcm(notification, recipients, targetApp) {
  const tokenEntries = [];
  const seen = new Set();
  for (const recipient of recipients) {
    for (const device of activeDeviceTokens(recipient.owner, recipient.role)) {
      if (!device.token || seen.has(device.token)) continue;
      seen.add(device.token);
      tokenEntries.push(device);
    }
  }
  if (!tokenEntries.length) {
    return { successCount: 0, failureCount: 0, invalidTokens: [], errors: [] };
  }

  const payloadData = dataPayload(notification, targetApp);
  const invalidTokens = [];
  const errors = [];
  let successCount = 0;
  let failureCount = 0;

  for (const batch of chunk(tokenEntries, FCM_BATCH_SIZE)) {
    const response = await admin.messaging().sendEachForMulticast({
      tokens: batch.map((entry) => entry.token),
      notification: {
        title: notification.title,
        body: notification.message,
        ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {})
      },
      data: payloadData,
      android: {
        priority: "high",
        notification: {
          channelId: targetApp === "PARTNER" ? "partner_admin_announcements" : "admin_announcements",
          sound: "default",
          ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {})
        }
      }
    });
    successCount += Number(response.successCount || 0);
    failureCount += Number(response.failureCount || 0);
    response.responses.forEach((result, index) => {
      if (result.success) return;
      const entry = batch[index];
      const code = result.error?.code || "messaging/unknown";
      const message = result.error?.message || code;
      errors.push({ tokenHash: entry.tokenHash || tokenHash(entry.token), code, message: message.slice(0, 240) });
      if (INVALID_FCM_CODES.has(code)) {
        invalidTokens.push({ token: entry.token, tokenHash: entry.tokenHash || tokenHash(entry.token) });
      }
    });
  }

  if (invalidTokens.length) await deactivateInvalidTokens(invalidTokens);
  return { successCount, failureCount, invalidTokens, errors: errors.slice(0, 50) };
}

async function deliverAdminNotification(notificationOrId) {
  const notification = typeof notificationOrId === "string"
    ? await AdminNotification.findById(notificationOrId)
    : notificationOrId;
  if (!notification) throw new Error("Notification not found");
  if (["sent", "partially_sent", "failed", "cancelled"].includes(notification.status)) {
    return notification;
  }

  notification.status = "sending";
  await notification.save();

  const recipients = await resolveRecipients(notification);
  const targetApp = targetAppFor(notification);
  await createInAppRecords(notification, recipients, targetApp);
  const delivery = await sendFcm(notification, recipients, targetApp);

  notification.recipientCount = recipients.length;
  notification.successCount = delivery.successCount;
  notification.failureCount = delivery.failureCount;
  notification.invalidTokenCount = delivery.invalidTokens.length;
  notification.errorMessages = delivery.errors;
  notification.sentAt = new Date();
  notification.status = delivery.successCount > 0 && delivery.failureCount > 0
    ? "partially_sent"
    : delivery.successCount > 0
      ? "sent"
      : "failed";
  await notification.save();

  emitAdminEvent("notification:sent", {
    notificationId: String(notification._id),
    title: notification.title,
    targetType: notification.targetType,
    status: notification.status,
    recipientCount: notification.recipientCount,
    successCount: notification.successCount,
    failureCount: notification.failureCount
  });
  return notification;
}

module.exports = {
  deliverAdminNotification,
  resolveRecipients,
  targetAppFor
};
