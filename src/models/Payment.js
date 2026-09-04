const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");
const { publicIdPlugin } = require("../utils/publicIds");

const paymentSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner" },
    serviceAmount: { type: Number, min: 0, default: 0 },
    additionalCharges: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, default: 0 },
    tax: { type: Number, min: 0, default: 0 },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: { type: String, enum: ["created", "processing", "paid", "failed", "refunded"], default: "created" },
    paymentMethod: { type: String, default: "razorpay", trim: true },
    paidAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    razorpayOrderId: String,
    razorpayOrderIdHash: { type: String, default: "", trim: true },
    razorpayPaymentId: String,
    razorpayPaymentIdHash: { type: String, default: "", trim: true },
    razorpaySignature: String
  },
  { timestamps: true }
);

paymentSchema.plugin(encryptedFieldsPlugin, {
  fields: ["razorpayOrderId", "razorpayPaymentId", "razorpaySignature"]
});

paymentSchema.index({ bookingId: 1, userId: 1, createdAt: -1 });
paymentSchema.index({ bookingId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ userId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ partnerId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ razorpayOrderIdHash: 1 }, { unique: true, partialFilterExpression: { razorpayOrderIdHash: { $gt: "" } } });
paymentSchema.index({ razorpayPaymentIdHash: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentIdHash: { $gt: "" } } });
paymentSchema.plugin(publicIdPlugin, { kind: "payment" });

module.exports = mongoose.model("Payment", paymentSchema);
