const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const partnerDocumentSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    documentType: { type: String, enum: ["id_proof", "address_proof", "skill_certificate"], required: true, index: true },
    originalName: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    contentHash: { type: String, default: "" },
    storageProvider: { type: String, enum: ["cloudinary", "inline"], default: "inline" },
    url: { type: String, default: "" },
    cloudinaryPublicId: { type: String, default: "" },
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
