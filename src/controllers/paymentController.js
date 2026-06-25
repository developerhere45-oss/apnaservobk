const crypto = require("crypto");
const { z } = require("zod");
const Payment = require("../models/Payment");
const User = require("../models/User");
const { Booking } = require("../models/Booking");
const razorpayClient = require("../config/razorpay");
const { reliableNotify } = require("../utils/reliableNotify");
const { activeDeviceTokens } = require("../utils/notificationTokens");
const { emitAdminEvent, serializeBooking } = require("../sockets/bookingSocket");

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

    const order = await client.orders.create({
      amount: Math.max(booking.price || 0, 1) * 100,
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
      amount: booking.price,
      status: "created",
      razorpayOrderId: order.id
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
    payment.razorpaySignature = razorpaySignature;
    await payment.save();
    emitAdminEvent("payment:confirmed", {
      ...serializeBooking(booking),
      paymentId: String(payment._id),
      amount: payment.amount,
      paymentStatus: payment.status,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: payment.razorpayPaymentId
    });

    await reliableNotify({
      recipients: [userRecipient(user)],
      title: "Payment Confirmed",
      body: "Your ApnaServo payment has been confirmed.",
      category: "payment",
      priority: "high",
      data: { type: "payment:confirmed", bookingId, bookingCode: booking?.bookingCode || "" },
      smsBody: `ApnaServo: Payment confirmed for booking ${booking?.bookingCode || bookingId}.`
    });

    return res.json({ ok: true, booking, payment });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createOrder,
  verifyPayment
};
