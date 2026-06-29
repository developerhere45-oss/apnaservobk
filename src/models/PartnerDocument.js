const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const partnerDocumentSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    documentType: {
      type: String,
      enum: [
        "aadhaar_front",
        "aadhaar_back",
        "pan_card",
        "selfie_photo",
        "id_proof",
        "address_proof",
        "experience_certificate",
        "skill_certificate",
        "training_certificate",
        "government_license",
        "trade_license",
        "other_supporting_document"
      ],
      required: true,
      index: true
    },
    originalName: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    contentHash: { type: String, default: "" },
    storageProvider: { type: String, enum: ["cloudinary", "inline", "mongodb"], default: "inline" },
    url: { type: String, default: "" },
    cloudinaryPublicId: { type: String, default: "" },
    partnerUploadAssetId: { type: mongoose.Schema.Types.ObjectId, ref: "PartnerUploadAsset", default: null },
    compressedByClient: { type: Boolean, default: false },
    originalSizeBytes: { type: Number, default: 0 },
    validationStatus: { type: String, enum: ["accepted", "rejected", "review"], default: "review", index: true },
    validationScore: { type: Number, default: 0 },
    validationReasons: { type: [String], default: [] },
    ocrStatus: { type: String, enum: ["not_configured", "passed", "failed", "skipped"], default: "skipped" },
    ocrTextHash: { type: String, default: "" },
    aadhaarLast4: { type: String, default: "" }
  },
  { timestamps: true }
);

partnerDocumentSchema.index({ partnerId: 1, documentType: 1, createdAt: -1 });
partnerDocumentSchema.index({ partnerId: 1, documentType: 1, validationStatus: 1, createdAt: -1 });
partnerDocumentSchema.index({ partnerId: 1, documentType: 1, contentHash: 1 });
partnerDocumentSchema.plugin(encryptedFieldsPlugin, {
  fields: ["originalName", "url", "cloudinaryPublicId", "ocrTextHash", "aadhaarLast4"]
});

module.exports = mongoose.model("PartnerDocument", partnerDocumentSchema);
