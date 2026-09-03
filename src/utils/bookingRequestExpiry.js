const { Booking } = require("../models/Booking");

// Partner requests no longer expire on a clock. Restore recent bookings that
// the legacy 10-minute scheduler closed so overnight requests can be routed
// again when an eligible partner polls or comes online.
async function restoreLegacyTimedOutRequests(now = new Date()) {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const result = await Booking.updateMany(
    {
      partnerId: null,
      status: "expired",
      expiryReason: "No partner accepted within 10 minutes",
      createdAt: { $gte: cutoff }
    },
    {
      $set: {
        status: "confirmed",
        requestExpiresAt: null,
        requestExpiredAt: null,
        expiryReason: "",
        requestedPartners: []
      },
      $push: {
        statusTimeline: {
          status: "confirmed",
          at: now,
          by: "system",
          note: "Restored after removal of timed partner-request expiry"
        }
      }
    }
  );
  const restored = Number(result.modifiedCount || 0);
  if (restored) console.log("restored_legacy_timed_booking_requests", { restored });
  return restored;
}

module.exports = { restoreLegacyTimedOutRequests };
