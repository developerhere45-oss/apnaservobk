const { Booking } = require("../models/Booking");
const { expireOutstandingRequests } = require("./partnerRequestTracking");

function requestTtlMs() {
  const configuredMinutes = Number(process.env.PARTNER_REQUEST_TTL_MINUTES || 10);
  const minutes = Number.isFinite(configuredMinutes) ? Math.min(60, Math.max(1, configuredMinutes)) : 10;
  return Math.round(minutes * 60 * 1000);
}

function partnerRequestExpiresAt(from = new Date()) {
  return new Date(new Date(from).getTime() + requestTtlMs());
}

// Server-side expiry prevents an offline/killed partner app from holding an
// old request open indefinitely.
async function expireDuePartnerRequests(now = new Date(), limit = 250) {
  const due = await Booking.find({
    partnerId: null,
    status: { $in: ["confirmed", "sent_to_partner"] },
    requestExpiresAt: { $type: "date", $lte: now }
  }).sort({ requestExpiresAt: 1 }).limit(limit);
  const expiredBookings = [];
  for (const booking of due) {
    const expiredRequests = expireOutstandingRequests(booking, { at: now });
    if (!expiredRequests.length) continue;
    booking.status = "expired";
    booking.requestExpiredAt = now;
    booking.requestedPartners = [];
    booking.statusTimeline.push({ status: "expired", at: now, by: "system", note: "No partner accepted before the request deadline" });
    await booking.save();
    expiredBookings.push({ booking, expiredRequests });
  }
  return expiredBookings;
}

function startPartnerRequestExpiryScheduler({ onExpired } = {}) {
  let running = false;
  const run = async () => {
    if (running) return [];
    running = true;
    try {
      const expired = await expireDuePartnerRequests();
      for (const entry of expired) await onExpired?.(entry);
      if (expired.length) console.log("partner_booking_requests_expired", { count: expired.length });
      return expired;
    } finally { running = false; }
  };
  run().catch((error) => console.error("partner_request_expiry_startup_failed", { message: error.message }));
  setInterval(() => run().catch((error) => console.error("partner_request_expiry_failed", { message: error.message })), 60 * 1000).unref();
  return run;
}

module.exports = { expireDuePartnerRequests, partnerRequestExpiresAt, requestTtlMs, startPartnerRequestExpiryScheduler };
