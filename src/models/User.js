const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  },
  { _id: false }
);

const savedAddressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: "Home" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [0, 0] }) },
    isDefault: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const registrationHistorySchema = new mongoose.Schema(
  {
    source: { type: String, trim: true, default: "user_app" },
    provider: { type: String, trim: true, default: "firebase" },
    registeredAt: { type: Date, default: Date.now },
    ip: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" }
  },
  { _id: false }
);

const loginHistorySchema = new mongoose.Schema(
  {
    loggedInAt: { type: Date, default: Date.now },
    ip: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" },
    deviceInfo: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const adminNoteSchema = new mongoose.Schema(
  {
    note: { type: String, trim: true, default: "" },
    addedBy: { type: String, trim: true, default: "admin" },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, default: "" },
    tokenHash: { type: String, trim: true, default: "", index: true },
    platform: { type: String, enum: ["android", "ios", "web"], default: "android" },
    deviceId: { type: String, trim: true, default: "" },
    appType: { type: String, enum: ["user"], default: "user" },
    isActive: { type: Boolean, default: true, index: true },
    lastUpdatedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true, default: "ApnaServo Customer" },
    phone: { type: String, trim: true, default: "" },
    phoneHash: { type: String, trim: true, default: "", index: true },
    email: { type: String, trim: true, lowercase: true, default: "" },
    emailHash: { type: String, trim: true, default: "", index: true },
    profilePhotoUrl: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    savedAddresses: { type: [savedAddressSchema], default: [] },
    city: { type: String, trim: true, default: "Guwahati" },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [0, 0] }) },
    phoneVerified: { type: Boolean, default: false, index: true },
    phoneVerifiedAt: { type: Date, default: null },
    bookingRiskStatus: { type: String, enum: ["unknown", "trusted", "otp_required", "review"], default: "unknown", index: true },
    fakeBookingWarningCount: { type: Number, default: 0 },
    lastBookingAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null, index: true },
    deviceInfo: { type: mongoose.Schema.Types.Mixed, default: {} },
    registrationHistory: { type: [registrationHistorySchema], default: [] },
    loginHistory: { type: [loginHistorySchema], default: [] },
    adminNotes: { type: [adminNoteSchema], default: [] },
    fcmToken: { type: String, default: "" },
    deviceTokens: { type: [deviceTokenSchema], default: [] },
    accountStatus: { type: String, enum: ["active", "suspended", "blocked", "deletion_requested", "deleted"], default: "active", index: true },
    deletionRequestedAt: { type: Date, default: null },
    deletionReason: { type: String, trim: true, default: "" }
  },
  { timestamps: true }
);

userSchema.index({ location: "2dsphere" });
userSchema.index({ city: 1, createdAt: -1 });
userSchema.index({ bookingRiskStatus: 1, lastBookingAt: -1 });
userSchema.index({ accountStatus: 1, deletionRequestedAt: -1 });
userSchema.index({ lastLoginAt: -1 });
userSchema.index({ "deviceTokens.tokenHash": 1, "deviceTokens.isActive": 1 });
userSchema.plugin(encryptedFieldsPlugin, {
  fields: [
    "name",
    "phone",
    "email",
    "profilePhotoUrl",
    "address",
    "savedAddresses.address",
    "fcmToken",
    "deviceTokens.token",
    "deviceTokens.deviceId",
    "deletionReason",
    "adminNotes.note"
  ]
});

module.exports = mongoose.model("User", userSchema);
