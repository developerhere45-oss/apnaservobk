const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const jobProofPhotoSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    stage: { type: String, enum: ["before", "after"], required: true, index: true },
    url: { type: String, default: "" },
    cloudinaryPublicId: { type: String, default: "" },
    storageProvider: { type: String, enum: ["cloudinary", "inline"], default: "inline" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    note: { type: String, default: "" },
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 },
    accuracy: { type: Number, default: 9999 }
  },
  { timestamps: true }
);

jobProofPhotoSchema.index({ bookingId: 1, stage: 1, createdAt: -1 });
jobProofPhotoSchema.index({ partnerId: 1, createdAt: -1 });
jobProofPhotoSchema.plugin(encryptedFieldsPlugin, {
  fields: ["url", "cloudinaryPublicId", "note"]
});

module.exports = mongoose.model("JobProofPhoto", jobProofPhotoSchema);
