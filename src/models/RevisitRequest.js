const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const revisitRequestSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    reason: { type: String, default: "same_issue_again", index: true },
    message: { type: String, default: "" },
    status: {
      type: String,
      enum: ["open", "partner_notified", "scheduled", "resolved", "rejected"],
      default: "open",
      index: true
    },
    warrantyEndDate: { type: Date, default: null },
    requestedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

revisitRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });
revisitRequestSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
revisitRequestSchema.index({ bookingId: 1, status: 1, createdAt: -1 });
revisitRequestSchema.plugin(encryptedFieldsPlugin, {
  fields: ["message"]
});

module.exports = mongoose.model("RevisitRequest", revisitRequestSchema);
