const mongoose = require("mongoose");

const inAppNotificationSchema = new mongoose.Schema(
  {
    recipientRole: { type: String, enum: ["user", "partner", "admin"], required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    recipientFirebaseUid: { type: String, default: "", index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: { type: String, default: "system", trim: true, index: true },
    category: { type: String, default: "system", trim: true, index: true },
    priority: { type: String, enum: ["normal", "high"], default: "normal" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingCode: { type: String, default: "", trim: true, index: true },
    readAt: { type: Date, default: null, index: true },
    pushStatus: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending" },
    pushSuccessCount: { type: Number, default: 0 },
    pushFailureCount: { type: Number, default: 0 },
    pushError: { type: String, default: "" },
    smsStatus: { type: String, enum: ["none", "sent", "failed", "not_configured", "skipped"], default: "none" },
    smsLogId: { type: mongoose.Schema.Types.ObjectId, ref: "SmsDeliveryLog", default: null }
  },
  { timestamps: true }
);

inAppNotificationSchema.index({ recipientRole: 1, createdAt: -1 });
inAppNotificationSchema.index({ userId: 1, createdAt: -1 });
inAppNotificationSchema.index({ partnerId: 1, createdAt: -1 });
inAppNotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
inAppNotificationSchema.index({ partnerId: 1, readAt: 1, createdAt: -1 });
inAppNotificationSchema.index({ recipientFirebaseUid: 1, createdAt: -1 });
inAppNotificationSchema.index({ category: 1, priority: 1, createdAt: -1 });

module.exports = mongoose.model("InAppNotification", inAppNotificationSchema);
