const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const fraudAlertSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorRole: { type: String, enum: ["user", "partner", "system"], default: "system", index: true },
    source: { type: String, default: "chat", index: true },
    type: { type: String, default: "off_app_deal_attempt", index: true },
    severity: { type: String, enum: ["low", "medium", "high"], default: "medium", index: true },
    message: { type: String, default: "" },
    matchedTerms: { type: [String], default: [] },
    actionTaken: { type: String, enum: ["logged", "warning_sent", "review_required"], default: "logged" },
    status: { type: String, enum: ["open", "reviewing", "resolved", "dismissed"], default: "open", index: true },
    metadata: { type: Object, default: {} }
  },
  { timestamps: true }
);

fraudAlertSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
fraudAlertSchema.index({ bookingId: 1, source: 1, createdAt: -1 });
fraudAlertSchema.index({ status: 1, severity: 1, createdAt: -1 });
fraudAlertSchema.plugin(encryptedFieldsPlugin, {
  fields: ["message"]
});

module.exports = mongoose.model("FraudAlert", fraudAlertSchema);
