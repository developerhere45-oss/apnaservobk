const Invoice = require("../models/Invoice");

function amount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : 0;
}

async function ensurePaidInvoice({ booking, payment, user, partner }) {
  if (!booking || !payment || payment.status !== "paid") return null;
  const finalAmount = amount(payment.amount);
  const data = {
    bookingId: booking._id,
    paymentId: payment._id,
    userId: booking.userId,
    partnerId: booking.partnerId || null,
    serviceDescription: booking.serviceName || booking.serviceCategory || "ApnaServo service",
    serviceAmount: amount(payment.serviceAmount || finalAmount),
    additionalCharges: amount(payment.additionalCharges),
    discount: amount(payment.discount),
    tax: amount(payment.tax),
    finalAmount,
    currency: payment.currency || "INR",
    paymentStatus: "paid",
    paymentMethod: payment.paymentMethod || "razorpay",
    transactionId: payment.razorpayPaymentId || "",
    paidAt: payment.paidAt || payment.verifiedAt || new Date(),
    customerName: user?.name || booking.userSnapshot?.name || "Customer",
    customerPhone: user?.phone || booking.userSnapshot?.phone || "",
    serviceAddress: booking.address || "",
    partnerName: partner?.name || booking.partnerSnapshot?.name || "Service Partner",
    bookingCode: booking.bookingCode || ""
  };
  let invoice;
  try {
    invoice = await Invoice.findOneAndUpdate(
      { bookingId: booking._id },
      { $setOnInsert: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    invoice = await Invoice.findOne({ bookingId: booking._id });
    if (!invoice) throw error;
  }
  if (!payment.invoiceId) {
    payment.invoiceId = invoice._id;
    await payment.save();
  }
  return invoice;
}

module.exports = { ensurePaidInvoice };
