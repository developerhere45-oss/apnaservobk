const mongoose = require("mongoose");

const adminActivitySchema = new mongoose.Schema(
  {
    eventName: { type: String, required: true, trim: true, index: true },
    category: { type: String, trim: true, default: "system", index: true },
    title: { type: String, trim: true, default: "" },
    detail: { type: String, trim: true, default: "" },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingCode: { type: String, trim: true, default: "", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    ticketId: { type: String, trim: true, default: "", index: true },
    complaintId: { type: String, trim: true, default: "", index: true },
    status: { type: String, trim: true, default: "", index: true },
    amount: { type: Number, default: 0 },
    actorRole: { type: String, trim: true, default: "" },
    actorName: { type: String, trim: true, default: "" },
    source: { type: String, trim: true, default: "backend" },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

adminActivitySchema.index({ createdAt: -1 });
adminActivitySchema.index({ category: 1, createdAt: -1 });
adminActivitySchema.index({ eventName: 1, createdAt: -1 });
adminActivitySchema.index({ bookingId: 1, createdAt: -1 });
adminActivitySchema.index({ userId: 1, createdAt: -1 });
adminActivitySchema.index({ partnerId: 1, createdAt: -1 });
adminActivitySchema.index({ ticketId: 1, createdAt: -1 });

module.exports = mongoose.model("AdminActivity", adminActivitySchema);
