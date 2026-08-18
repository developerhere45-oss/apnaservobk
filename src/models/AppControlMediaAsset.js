const mongoose = require("mongoose");

// Tracks media uploaded from App Control. Cloudinary remains the primary
// production store; the inline copy is only the resilient fallback when the
// production storage credentials are intentionally not configured.
const appControlMediaAssetSchema = new mongoose.Schema(
  {
    mimeType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true },
    originalName: { type: String, trim: true, default: "" },
    sizeBytes: { type: Number, min: 1, max: 5 * 1024 * 1024, required: true },
    storageProvider: { type: String, enum: ["cloudinary", "mongodb"], required: true },
    url: { type: String, trim: true, default: "" },
    publicId: { type: String, trim: true, default: "" },
    dataBase64: { type: String, default: "" },
    createdBy: { type: String, trim: true, default: "admin-dashboard" },
  },
  { timestamps: true },
);

appControlMediaAssetSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AppControlMediaAsset", appControlMediaAssetSchema);
