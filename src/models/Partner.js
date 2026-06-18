const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  },
  { _id: false }
);

const partnerSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    partnerCode: { type: String, unique: true, sparse: true },
    name: { type: String, trim: true, default: "ApnaServo Partner" },
    phone: { type: String, trim: true, default: "" },
    phoneHash: { type: String, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    emailHash: { type: String, default: "" },
    serviceCategory: { type: [String], default: ["ac"] },
    isOnline: { type: Boolean, default: true, index: true },
    isVerified: { type: Boolean, default: true },
    city: { type: String, trim: true, default: "Guwahati" },
    serviceArea: { type: String, trim: true, default: "Guwahati, Assam" },
    serviceRadiusKm: { type: Number, default: 25 },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [91.7362, 26.1445] }) },
    lastLocationAt: { type: Date, default: null },
    lastLocationAccuracy: { type: Number, default: 9999 },
    lastLocationProvider: { type: String, default: "" },
    locationTrustStatus: { type: String, enum: ["unknown", "trusted", "suspicious"], default: "unknown" },
    faceVerified: { type: Boolean, default: false },
    selfieVerified: { type: Boolean, default: false },
    selfieUrl: { type: String, default: "" },
    faceLivenessStatus: { type: String, enum: ["missing", "passed", "failed"], default: "missing", index: true },
    faceLivenessVerifiedAt: { type: Date, default: null },
    faceLivenessSessionId: { type: String, default: "" },
    faceLivenessChecks: {
      blink: { type: Boolean, default: false },
      lookLeft: { type: Boolean, default: false },
      lookRight: { type: Boolean, default: false },
      smile: { type: Boolean, default: false },
      turnHead: { type: Boolean, default: false },
      stepCount: { type: Number, default: 0 },
      source: { type: String, enum: ["video", ""], default: "" },
      videoDurationMs: { type: Number, default: 0 },
      videoFrameCount: { type: Number, default: 0 }
    },
    aadhaarLast4: { type: String, default: "" },
    aadhaarStatus: { type: String, enum: ["missing", "submitted", "verified", "rejected"], default: "missing", index: true },
    aadhaarVerified: { type: Boolean, default: false },
    idProofUrl: { type: String, default: "" },
    idProofStatus: { type: String, enum: ["missing", "submitted", "verified", "rejected"], default: "missing", index: true },
    skillCertificateUrl: { type: String, default: "" },
    skillCertificateStatus: { type: String, enum: ["missing", "submitted", "verified", "rejected"], default: "missing", index: true },
    kycStatus: { type: String, enum: ["missing", "pending_review", "verified", "rejected"], default: "missing", index: true },
    fraudWarningCount: { type: Number, default: 0 },
    trustStatus: { type: String, enum: ["trusted", "warning", "review_required", "suspended"], default: "trusted", index: true },
    lastFraudWarningAt: { type: Date, default: null },
    earnings: { type: Number, default: 0 },
    rating: { type: Number, default: 4.8 },
    ratingCount: { type: Number, default: 0 },
    totalJobs: { type: Number, default: 0 },
    responseRate: { type: Number, default: 92 },
    fcmToken: { type: String, default: "" },
    photoUrl: { type: String, default: "" },
    accountStatus: { type: String, enum: ["active", "deletion_requested", "deleted"], default: "active", index: true },
    deletionRequestedAt: { type: Date, default: null },
    deletionReason: { type: String, trim: true, default: "" }
  },
  { timestamps: true }
);

partnerSchema.index({ location: "2dsphere" });
partnerSchema.index({ serviceCategory: 1, isOnline: 1, city: 1 });
partnerSchema.index({ serviceCategory: 1, isOnline: 1, isVerified: 1, trustStatus: 1, city: 1 });
partnerSchema.index({ isOnline: 1, lastLocationAt: -1 });
partnerSchema.index({ kycStatus: 1, faceVerified: 1, selfieVerified: 1, aadhaarVerified: 1 });
partnerSchema.index({ accountStatus: 1, deletionRequestedAt: -1 });
partnerSchema.index({ phoneHash: 1 }, { unique: true, partialFilterExpression: { phoneHash: { $type: "string", $gt: "" } } });
partnerSchema.index({ emailHash: 1 }, { unique: true, partialFilterExpression: { emailHash: { $type: "string", $gt: "" } } });
partnerSchema.plugin(encryptedFieldsPlugin, {
  fields: ["name", "phone", "email", "serviceArea", "fcmToken", "photoUrl", "selfieUrl", "faceLivenessSessionId", "aadhaarLast4", "idProofUrl", "skillCertificateUrl", "deletionReason"]
});

module.exports = mongoose.model("Partner", partnerSchema);
