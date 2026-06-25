const mongoose = require("mongoose");

const deliveryErrorSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, trim: true, default: "" },
    code: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" }
  },
  { _id: false }
);

const adminNotificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    imageUrl: { type: String, trim: true, default: "" },
    targetType: {
      type: String,
      enum: ["ALL_USERS", "ALL_PARTNERS", "SPECIFIC_USER", "SPECIFIC_PARTNER"],
      required: true,
      index: true
    },
    targetUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],
    targetPartnerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Partner", index: true }],
    actionType: {
      type: String,
      enum: ["NONE", "OPEN_HOME", "OPEN_NOTIFICATIONS", "OPEN_SERVICE", "OPEN_BOOKING", "OPEN_OFFERS", "OPEN_PARTNER_HOME", "OPEN_PARTNER_BOOKING"],
      default: "NONE",
      index: true
    },
    actionId: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["draft", "scheduled", "sending", "sent", "partially_sent", "failed", "cancelled"],
      default: "draft",
      index: true
    },
    scheduleAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null, index: true },
    sentBy: { type: String, trim: true, default: "admin-dashboard" },
    sentByEmail: { type: String, trim: true, lowercase: true, default: "" },
    recipientCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    invalidTokenCount: { type: Number, default: 0 },
    errorMessages: { type: [deliveryErrorSchema], default: [] },
    idempotencyKey: { type: String, trim: true, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

adminNotificationSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } } }
);
adminNotificationSchema.index({ status: 1, scheduleAt: 1 });
adminNotificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
