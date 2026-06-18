const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");
const { otpExpiresAt } = require("../utils/otpPolicy");
const { hashSecret, verifySecret } = require("../utils/passwordHash");

const otpChallengeSchema = new mongoose.Schema(
  {
    ownerFirebaseUid: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    purpose: {
      type: String,
      enum: ["login", "booking", "payment", "profile"],
      default: "login",
      index: true
    },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    expiresAt: { type: Date, default: otpExpiresAt },
    consumedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ ownerFirebaseUid: 1, purpose: 1, consumedAt: 1, createdAt: -1 });
otpChallengeSchema.plugin(encryptedFieldsPlugin, {
  fields: ["phone", "email"]
});

otpChallengeSchema.statics.createForOtp = async function createForOtp(input = {}) {
  const otpHash = await hashSecret(input.otp);
  return this.create({
    ownerFirebaseUid: input.ownerFirebaseUid || "",
    phone: input.phone || "",
    email: input.email || "",
    purpose: input.purpose || "login",
    otpHash,
    expiresAt: input.expiresAt || otpExpiresAt()
  });
};

otpChallengeSchema.methods.verifyOtp = async function verifyOtp(otp) {
  if (this.consumedAt || this.expiresAt <= new Date() || this.attempts >= this.maxAttempts) {
    return false;
  }

  this.attempts += 1;
  const ok = await verifySecret(otp, this.otpHash);
  if (ok) {
    this.consumedAt = new Date();
  }
  await this.save();
  return ok;
};

module.exports = mongoose.model("OtpChallenge", otpChallengeSchema);
