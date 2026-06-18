const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const smsDeliveryLogSchema = new mongoose.Schema(
  {
    notificationId: { type: mongoose.Schema.Types.ObjectId, ref: "InAppNotification", default: null, index: true },
    recipientRole: { type: String, enum: ["user", "partner", "admin"], default: "user", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    phone: { type: String, default: "" },
    body: { type: String, default: "" },
    provider: { type: String, default: "" },
    status: { type: String, enum: ["sent", "failed", "not_configured", "skipped"], default: "skipped", index: true },
    error: { type: String, default: "" },
    responseCode: { type: Number, default: 0 },
    responseBody: { type: String, default: "" }
  },
  { timestamps: true }
);

smsDeliveryLogSchema.plugin(encryptedFieldsPlugin, {
  fields: ["phone", "body", "responseBody"]
});

smsDeliveryLogSchema.index({ recipientRole: 1, status: 1, createdAt: -1 });
smsDeliveryLogSchema.index({ userId: 1, createdAt: -1 });
smsDeliveryLogSchema.index({ partnerId: 1, createdAt: -1 });
smsDeliveryLogSchema.index({ notificationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("SmsDeliveryLog", smsDeliveryLogSchema);
