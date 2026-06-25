const InAppNotification = require("../models/InAppNotification");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { normalizeDeviceToken, removeDeviceToken, upsertDeviceToken } = require("../utils/notificationTokens");

function serializeNotification(notification) {
  return {
    id: String(notification._id),
    title: notification.title,
    body: notification.body,
    type: notification.type,
    category: notification.category,
    priority: notification.priority,
    data: notification.data || {},
    imageUrl: notification.imageUrl || notification.data?.imageUrl || "",
    actionType: notification.actionType || notification.data?.actionType || "NONE",
    actionId: notification.actionId || notification.data?.actionId || "",
    adminNotificationId: notification.adminNotificationId ? String(notification.adminNotificationId) : "",
    bookingId: notification.bookingId ? String(notification.bookingId) : "",
    bookingCode: notification.bookingCode || "",
    readAt: notification.readAt ? notification.readAt.toISOString() : "",
    pushStatus: notification.pushStatus,
    smsStatus: notification.smsStatus,
    createdAt: notification.createdAt ? notification.createdAt.toISOString() : ""
  };
}

async function ownerQuery(req) {
  const role = String(req.query.role || "").toLowerCase();
  if (role === "partner") {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    return partner ? { recipientRole: "partner", partnerId: partner._id } : null;
  }
  if (role === "user") {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    return user ? { recipientRole: "user", userId: user._id } : null;
  }

  const [user, partner] = await Promise.all([
    User.findOne({ firebaseUid: req.auth.uid }),
    Partner.findOne({ firebaseUid: req.auth.uid })
  ]);
  if (partner) {
    return { recipientRole: "partner", partnerId: partner._id };
  }
  if (user) {
    return { recipientRole: "user", userId: user._id };
  }
  return null;
}

async function listNotifications(req, res, next) {
  try {
    const query = await ownerQuery(req);
    if (!query) {
      return res.json({ notifications: [], unreadCount: 0 });
    }
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const page = Math.max(Number(req.query.page || 1), 1);
    const notifications = await InAppNotification.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    const unreadCount = await InAppNotification.countDocuments({ ...query, readAt: null });
    const total = await InAppNotification.countDocuments(query);
    return res.json({
      notifications: notifications.map(serializeNotification),
      unreadCount,
      total,
      page,
      limit
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const query = await ownerQuery(req);
    if (!query) {
      return res.status(404).json({ message: "Notification not found" });
    }
    const notification = await InAppNotification.findOneAndUpdate(
      { _id: req.params.notificationId, ...query },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    return res.json({ notification: serializeNotification(notification) });
  } catch (error) {
    return next(error);
  }
}

async function markAllRead(req, res, next) {
  try {
    const query = await ownerQuery(req);
    if (!query) return res.json({ ok: true, modifiedCount: 0 });
    const result = await InAppNotification.updateMany(
      { ...query, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return res.json({ ok: true, modifiedCount: result.modifiedCount || 0 });
  } catch (error) {
    return next(error);
  }
}

async function ownerForDeviceToken(req, requestedAppType) {
  const appType = String(requestedAppType || "").toLowerCase();
  if (appType === "partner") {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    return partner ? { appType: "partner", owner: partner } : null;
  }
  const user = await User.findOne({ firebaseUid: req.auth.uid });
  return user ? { appType: "user", owner: user } : null;
}

async function saveDeviceToken(req, res, next) {
  try {
    const appType = String(req.body?.appType || req.query.appType || "user").toLowerCase() === "partner" ? "partner" : "user";
    const deviceToken = normalizeDeviceToken({
      token: req.body?.token || req.body?.fcmToken,
      platform: req.body?.platform || "android",
      deviceId: req.body?.deviceId || "",
      appType
    });
    if (!deviceToken) return res.status(400).json({ message: "Valid FCM token is required" });
    const identity = await ownerForDeviceToken(req, appType);
    if (!identity) return res.status(404).json({ message: `${appType} profile not found for authenticated account` });
    const { owner } = identity;
    upsertDeviceToken(owner, deviceToken);
    await owner.save();
    return res.json({ ok: true, appType, ownerId: owner._id, deviceId: deviceToken.deviceId });
  } catch (error) {
    return next(error);
  }
}

async function deleteDeviceToken(req, res, next) {
  try {
    const appType = String(req.body?.appType || req.query.appType || "user").toLowerCase() === "partner" ? "partner" : "user";
    const tokenOrDeviceId = req.body?.token || req.body?.fcmToken || req.body?.deviceId || req.query.deviceId || "";
    if (!String(tokenOrDeviceId || "").trim()) return res.status(400).json({ message: "token or deviceId is required" });
    const identity = await ownerForDeviceToken(req, appType);
    if (!identity) return res.status(404).json({ message: `${appType} profile not found for authenticated account` });
    const { owner } = identity;
    const removed = removeDeviceToken(owner, tokenOrDeviceId);
    if (removed) await owner.save();
    return res.json({ ok: true, removed });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllRead,
  saveDeviceToken,
  deleteDeviceToken
};
