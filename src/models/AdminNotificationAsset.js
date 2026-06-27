const mongoose = require("mongoose");

const adminNotificationAssetSchema = new mongoose.Schema(
  {
    mimeType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true },
    originalName: { type: String, trim: true, default: "" },
    sizeBytes: { type: Number, default: 0 },
    dataBase64: { type: String, required: true },
    createdBy: { type: String, trim: true, default: "admin-dashboard" },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 45 * 24 * 60 * 60 * 1000) }
  },
  { timestamps: true }
);

adminNotificationAssetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AdminNotificationAsset", adminNotificationAssetSchema);
