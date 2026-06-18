const mongoose = require("mongoose");

const locationLogSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingCode: { type: String, default: "", index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: 9999 },
    provider: { type: String, default: "" },
    isMock: { type: Boolean, default: false },
    validationStatus: { type: String, enum: ["accepted", "rejected"], required: true, index: true },
    reason: { type: String, default: "" },
    speedMps: { type: Number, default: 0 },
    distanceToCustomerM: { type: Number, default: 0 },
    recordedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

locationLogSchema.index({ partnerId: 1, recordedAt: -1 });
locationLogSchema.index({ bookingId: 1, recordedAt: -1 });
locationLogSchema.index({ bookingId: 1, partnerId: 1, validationStatus: 1, recordedAt: -1 });

module.exports = mongoose.model("LocationLog", locationLogSchema);
