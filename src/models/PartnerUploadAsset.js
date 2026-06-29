const mongoose = require("mongoose");

const partnerUploadAssetSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "PartnerDocument", default: null, index: true },
    kind: { type: String, enum: ["profile_photo", "document"], required: true, index: true },
    documentType: { type: String, trim: true, default: "" },
    mimeType: { type: String, enum: ["image/jpeg", "image/png"], required: true },
    originalName: { type: String, trim: true, default: "" },
    sizeBytes: { type: Number, default: 0 },
    contentHash: { type: String, trim: true, default: "", index: true },
    dataBase64: { type: String, required: true }
  },
  { timestamps: true }
);

partnerUploadAssetSchema.index({ partnerId: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.model("PartnerUploadAsset", partnerUploadAssetSchema);
