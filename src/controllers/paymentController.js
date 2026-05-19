const crypto = require("crypto");
const Payment = require("../models/Payment");
const User = require("../models/User");
const { Booking } = require("../models/Booking");
const razorpayClient = require("../config/razorpay");
const sendNotification = require("../utils/sendNotification");

async function createOrder(req, res, next) {
  try {
    const client = razorpayClient();
    if (!client) {
      return res.status(503).json({ message: "Razorpay keys are not configured" });
    }

    const user = await User.findOne({ firebaseUid: req.auth.uid });
    const booking = await Booking.findOne({ _id: req.body.bookingId, userId: user?._id });
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

    await Payment.create({
      bookingId: booking._id,
      userId: booking.userId,
      partnerId: booking.partnerId,
      amount: booking.price,
      status: "created",
      razorpayOrderId: order.id
    });

    return res.json({ order });
  } catch (error) {
    return next(error);
  }
}

async function verifyPayment(req, res, next) {
  try {
    const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expected !== razorpaySignature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const booking = await Booking.findByIdAndUpdate(
      bookingId,
      { $set: { paymentStatus: "paid" } },
      { new: true }
    );

    const payment = await Payment.findOneAndUpdate(
      { bookingId, razorpayOrderId },
      {
        $set: {
          status: "paid",
          razorpayPaymentId,
          razorpaySignature
        }
      },
      { new: true }
    );

    const user = booking ? await User.findById(booking.userId) : null;
    await sendNotification({
      token: user?.fcmToken,
      title: "Payment Confirmed",
      body: "Your ApnaServo payment has been confirmed.",
      data: { type: "payment:confirmed", bookingId }
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
