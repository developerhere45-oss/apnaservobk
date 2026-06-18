const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const customerNoResponseReportSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reason: { type: String, default: "" },
    evidenceUrl: { type: String, default: "" },
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 },
    accuracy: { type: Number, default: 9999 },
    provider: { type: String, default: "" },
    status: { type: String, enum: ["open", "reviewing", "resolved", "dismissed"], default: "open", index: true },
    reportedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

customerNoResponseReportSchema.index({ partnerId: 1, createdAt: -1 });
customerNoResponseReportSchema.index({ userId: 1, status: 1, createdAt: -1 });
customerNoResponseReportSchema.index({ bookingId: 1, status: 1, createdAt: -1 });
customerNoResponseReportSchema.plugin(encryptedFieldsPlugin, {
  fields: ["reason", "evidenceUrl"]
});

module.exports = mongoose.model("CustomerNoResponseReport", customerNoResponseReportSchema);
