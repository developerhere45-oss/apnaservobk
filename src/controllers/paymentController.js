const crypto = require("crypto");
const { z } = require("zod");
const Payment = require("../models/Payment");
const User = require("../models/User");
const { Booking } = require("../models/Booking");
const razorpayClient = require("../config/razorpay");
const { reliableNotify } = require("../utils/reliableNotify");
const { activeDeviceTokens } = require("../utils/notificationTokens");
const { emitAdminEvent, serializeBooking } = require("../sockets/bookingSocket");
const Partner = require("../models/Partner");
const { ensurePaidInvoice } = require("../services/invoiceService");

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);
const createOrderSchema = z.object({
  bookingId: objectIdSchema
});

const verifyPaymentSchema = z.object({
  bookingId: objectIdSchema,
  razorpayOrderId: z.string().trim().min(3).max(120),
  razorpayPaymentId: z.string().trim().min(3).max(120),
  razorpaySignature: z.string().trim().regex(/^[a-f0-9]{64}$/i)
});

function userRecipient(user) {
  if (!user) return null;
  const tokens = activeDeviceTokens(user, "user").map((device) => device.token);
  return {
    role: "user",
    userId: user._id,
    firebaseUid: user.firebaseUid,
    token: tokens[0] || user.fcmToken,
    tokens,
    phone: user.phone
  };
}

function secureEqualHex(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  if (!/^[a-f0-9]{64}$/i.test(leftText) || !/^[a-f0-9]{64}$/i.test(rightText)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(leftText, "hex"), Buffer.from(rightText, "hex"));
}

function referenceHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function authoritativeAmount(booking) {
  const value = Number(booking.finalAmount || booking.quoteAmount || booking.price || 0);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

async function createOrder(req, res, next) {
  try {
    const body = createOrderSchema.parse(req.body || {});
    const client = razorpayClient();
    if (!client) {
      return res.status(503).json({ message: "Razorpay keys are not configured" });
    }

    const user = await User.findOne({ firebaseUid: req.auth.uid });
    const booking = await Booking.findOne({ _id: body.bookingId, userId: user?._id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const finalAmount = authoritativeAmount(booking);
    if (finalAmount <= 0) {
      return res.status(409).json({ message: "Final payable amount is not available" });
    }

    const reusablePayment = await Payment.findOne({
      bookingId: booking._id,
      userId: user._id,
      amount: finalAmount,
      status: { $in: ["created", "processing"] }
    }).sort({ createdAt: -1 });
    if (reusablePayment?.razorpayOrderId) {
      return res.json({
        order: {
          id: reusablePayment.razorpayOrderId,
          amount: Math.round(reusablePayment.amount * 100),
          currency: reusablePayment.currency,
          receipt: booking.bookingCode
        },
        idempotent: true
      });
    }

    const order = await client.orders.create({
      amount: Math.round(finalAmount * 100),
      currency: "INR",
      receipt: booking.bookingCode,
      notes: {
        bookingId: String(booking._id),
        serviceCategory: booking.serviceCategory
      }
    });

    const payment = await Payment.create({
      bookingId: booking._id,
      userId: booking.userId,
      partnerId: booking.partnerId,
      serviceAmount: finalAmount,
      amount: finalAmount,
      status: "created",
      razorpayOrderId: order.id,
      razorpayOrderIdHash: referenceHash(order.id)
    });
    emitAdminEvent("payment:created", {
      ...serializeBooking(booking),
      paymentId: String(payment._id),
      amount: payment.amount,
      paymentStatus: payment.status,
      razorpayOrderId: payment.razorpayOrderId
    });

    return res.json({ order });
  } catch (error) {
    return next(error);
  }
}

async function verifyPayment(req, res, next) {
  try {
    const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = verifyPaymentSchema.parse(req.body || {});

    const user = await User.findOne({ firebaseUid: req.auth.uid });
    const booking = await Booking.findOne({ _id: bookingId, userId: user?._id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const payment = await Payment.findOne({ bookingId: booking._id, userId: user._id }).sort({ createdAt: -1 });
    if (!payment) {
      return res.status(404).json({ message: "Payment order not found" });
    }

    if (payment.razorpayOrderId !== razorpayOrderId) {
      return res.status(400).json({ message: "Payment order mismatch" });
    }

    if (payment.amount !== authoritativeAmount(booking)) {
      return res.status(409).json({ message: "Booking amount changed. Create a new payment order." });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (!secureEqualHex(expected, razorpaySignature)) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    if (payment.status === "paid" && payment.razorpayPaymentId === razorpayPaymentId) {
      return res.json({ ok: true, booking, payment });
    }

    booking.paymentStatus = "paid";
    await booking.save();

    payment.status = "paid";
    payment.razorpayPaymentId = razorpayPaymentId;
    payment.razorpayPaymentIdHash = referenceHash(razorpayPaymentId);
    payment.razorpaySignature = razorpaySignature;
    payment.paidAt = new Date();
    payment.verifiedAt = payment.paidAt;
    await payment.save();
    const partner = booking.partnerId ? await Partner.findById(booking.partnerId) : null;
    const invoice = await ensurePaidInvoice({ booking, payment, user, partner });
    emitAdminEvent("payment:confirmed", {
      ...serializeBooking(booking),
      paymentId: String(payment._id),
      amount: payment.amount,
      paymentStatus: payment.status,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: payment.razorpayPaymentId
    });

    try {
      await reliableNotify({
        recipients: [userRecipient(user)],
        title: "Payment Confirmed",
        body: "Your ApnaServo payment has been confirmed.",
        category: "payment",
        priority: "high",
        data: { type: "payment:confirmed", bookingId, bookingCode: booking?.bookingCode || "" },
        smsBody: `ApnaServo: Payment confirmed for booking ${booking?.bookingCode || bookingId}.`
      });
    } catch (notificationError) {
      console.error("payment_confirmation_notification_failed", {
        requestId: req.requestId || "",
        bookingId,
        paymentId: String(payment._id),
        message: notificationError?.message || "Unknown notification error"
      });
    }

    return res.json({ ok: true, booking, payment, invoice });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createOrder,
  verifyPayment
};
