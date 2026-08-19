const { Booking } = require("../models/Booking");
const User = require("../models/User");
const { reliableNotify } = require("./reliableNotify");
const { activeDeviceTokens } = require("./notificationTokens");
const { emitBookingStatusUpdate } = require("../sockets/bookingSocket");

const SWEEP_INTERVAL_MS = 15 * 1000;
const SWEEP_BATCH_SIZE = 100;
let scheduler;
let sweepInFlight = false;

function userRecipient(user) {
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

async function expireOne(candidateId, now) {
  const booking = await Booking.findOneAndUpdate(
    {
      _id: candidateId,
      partnerId: null,
      status: { $in: ["pending", "sent_to_partner"] },
      requestExpiresAt: { $ne: null, $lte: now }
    },
    {
      $set: {
        status: "expired",
        requestExpiredAt: now,
        expiryReason: "No partner accepted within 10 minutes",
        requestedPartners: []
      },
      $push: {
        statusTimeline: {
          status: "expired",
          at: now,
          by: "system",
          note: "No partner accepted within 10 minutes; customer may retry as a new booking"
        }
      }
    },
    { new: true }
  );
  if (!booking) return null;

  emitBookingStatusUpdate(booking);
  try {
    const user = await User.findById(booking.userId);
    if (user) {
      await reliableNotify({
        recipients: [userRecipient(user)],
        title: "No partner accepted your booking",
        body: `Booking ${booking.bookingCode} is closed. Tap to retry the booking.`,
        category: "booking_status",
        priority: "high",
        data: {
          type: "booking:request_expired",
          status: "expired",
          bookingId: booking.bookingId || booking.publicId || booking.bookingCode,
          internalBookingId: String(booking._id),
          bookingCode: booking.bookingCode,
          actionType: "OPEN_BOOKING"
        },
        smsBody: ""
      });
    }
  } catch (error) {
    console.error("Expired booking notification failed:", error.message);
  }
  return booking;
}

async function expireDueBookingRequests(filter = {}) {
  const now = new Date();
  const candidates = await Booking.find({
    ...filter,
    partnerId: null,
    status: { $in: ["pending", "sent_to_partner"] },
    requestExpiresAt: { $ne: null, $lte: now }
  }).select("_id").sort({ requestExpiresAt: 1 }).limit(SWEEP_BATCH_SIZE).lean();

  const expired = [];
  for (const candidate of candidates) {
    const booking = await expireOne(candidate._id, now);
    if (booking) expired.push(booking);
  }
  return expired;
}

async function tick() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await expireDueBookingRequests();
  } finally {
    sweepInFlight = false;
  }
}

function startBookingRequestExpiryScheduler() {
  if (scheduler || process.env.DISABLE_BOOKING_EXPIRY_SCHEDULER === "true") return;
  setTimeout(() => tick().catch((error) => console.error("Booking expiry sweep failed:", error.message)), 1000).unref?.();
  scheduler = setInterval(() => {
    tick().catch((error) => console.error("Booking expiry sweep failed:", error.message));
  }, SWEEP_INTERVAL_MS);
  scheduler.unref?.();
}

module.exports = {
  expireDueBookingRequests,
  startBookingRequestExpiryScheduler
};
