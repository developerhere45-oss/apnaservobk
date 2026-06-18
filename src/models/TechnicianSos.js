const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const technicianSosSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reason: {
      type: String,
      enum: ["emergency", "unsafe_location", "customer_issue", "accident", "other"],
      default: "emergency",
      index: true
    },
    note: { type: String, default: "" },
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 },
    accuracy: { type: Number, default: 9999 },
    status: { type: String, enum: ["open", "acknowledged", "resolved"], default: "open", index: true },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

technicianSosSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
technicianSosSchema.index({ bookingId: 1, createdAt: -1 });
technicianSosSchema.plugin(encryptedFieldsPlugin, {
  fields: ["note"]
});

module.exports = mongoose.model("TechnicianSos", technicianSosSchema);
