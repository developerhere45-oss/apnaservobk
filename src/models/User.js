const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true, default: "ApnaServo Customer" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "Guwahati" },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [0, 0] }) },
    phoneVerified: { type: Boolean, default: false, index: true },
    phoneVerifiedAt: { type: Date, default: null },
    bookingRiskStatus: { type: String, enum: ["unknown", "trusted", "otp_required", "review"], default: "unknown", index: true },
    fakeBookingWarningCount: { type: Number, default: 0 },
    lastBookingAt: { type: Date, default: null },
    fcmToken: { type: String, default: "" },
    accountStatus: { type: String, enum: ["active", "deletion_requested", "deleted"], default: "active", index: true },
    deletionRequestedAt: { type: Date, default: null },
    deletionReason: { type: String, trim: true, default: "" }
  },
  { timestamps: true }
);

userSchema.index({ location: "2dsphere" });
userSchema.index({ city: 1, createdAt: -1 });
userSchema.index({ bookingRiskStatus: 1, lastBookingAt: -1 });
userSchema.index({ accountStatus: 1, deletionRequestedAt: -1 });
userSchema.plugin(encryptedFieldsPlugin, {
  fields: ["name", "phone", "email", "address", "fcmToken", "deletionReason"]
});

module.exports = mongoose.model("User", userSchema);
