const mongoose = require("mongoose");

const commissionLedgerSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    bookingCode: { type: String, default: "", index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    grossAmount: { type: Number, default: 0 },
    commissionRate: { type: Number, default: 0.1 },
    commissionAmount: { type: Number, default: 0 },
    netPayable: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "settled", "reversed"], default: "pending", index: true },
    source: { type: String, enum: ["booking_completion", "manual"], default: "booking_completion" },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

commissionLedgerSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
commissionLedgerSchema.index({ partnerId: 1, completedAt: -1 });
commissionLedgerSchema.index({ status: 1, completedAt: -1 });

module.exports = mongoose.model("CommissionLedger", commissionLedgerSchema);
