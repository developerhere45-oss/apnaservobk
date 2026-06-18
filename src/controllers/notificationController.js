const InAppNotification = require("../models/InAppNotification");
const User = require("../models/User");
const Partner = require("../models/Partner");

function serializeNotification(notification) {
  return {
    id: String(notification._id),
    title: notification.title,
    body: notification.body,
    type: notification.type,
    category: notification.category,
    priority: notification.priority,
    data: notification.data || {},
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
    const notifications = await InAppNotification.find(query).sort({ createdAt: -1 }).limit(limit);
    const unreadCount = await InAppNotification.countDocuments({ ...query, readAt: null });
    return res.json({
      notifications: notifications.map(serializeNotification),
      unreadCount
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

module.exports = {
  listNotifications,
  markNotificationRead
};
