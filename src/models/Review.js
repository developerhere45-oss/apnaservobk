const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const reviewSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["published", "under_dispute", "hidden"], default: "published", index: true },
    disputeStatus: { type: String, enum: ["none", "open", "resolved"], default: "none", index: true },
    disputedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    adminResolution: { type: String, default: "" }
  },
  { timestamps: true }
);

reviewSchema.index({ bookingId: 1 }, { unique: true });
reviewSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
reviewSchema.plugin(encryptedFieldsPlugin, {
  fields: ["comment", "adminResolution"]
});

module.exports = mongoose.model("Review", reviewSchema);
