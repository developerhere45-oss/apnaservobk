const mongoose = require("mongoose");

const callLogSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    action: { type: String, enum: ["start", "report"], required: true, index: true },
    direction: { type: String, enum: ["partner_to_customer", "user_to_partner"], default: "partner_to_customer" },
    status: {
      type: String,
      enum: ["virtual_call_ready", "direct_call_ready", "virtual_call_unconfigured", "reported"],
      required: true,
      index: true
    },
    customerPhoneMasked: { type: String, default: "" },
    virtualNumber: { type: String, default: "" },
    reason: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" }
  },
  { timestamps: true }
);

callLogSchema.index({ partnerId: 1, bookingId: 1, createdAt: -1 });
callLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("CallLog", callLogSchema);
