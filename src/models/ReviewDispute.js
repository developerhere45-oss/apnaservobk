const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const reviewDisputeSchema = new mongoose.Schema(
  {
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reason: {
      type: String,
      enum: ["revenge_review", "fake_claim", "abusive_language", "wrong_booking", "other"],
      default: "other",
      index: true
    },
    details: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["open", "reviewing", "accepted", "rejected"], default: "open", index: true },
    resolutionNote: { type: String, trim: true, default: "" },
    resolvedBy: { type: String, default: "" },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

reviewDisputeSchema.index({ reviewId: 1, status: 1 });
reviewDisputeSchema.index({ status: 1, createdAt: -1 });
reviewDisputeSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
reviewDisputeSchema.plugin(encryptedFieldsPlugin, {
  fields: ["details", "resolutionNote"]
});

module.exports = mongoose.model("ReviewDispute", reviewDisputeSchema);
