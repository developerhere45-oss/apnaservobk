const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Booking } = require("../src/models/Booking");
const { pendingAssignmentStatuses } = require("../src/utils/bookingLifecycle");
const { expireDueBookingRequests } = require("../src/utils/bookingRequestExpiry");

async function claimBooking(bookingId, partnerId) {
  return Booking.findOneAndUpdate(
    {
      _id: bookingId,
      partnerId: null,
      requestedPartners: partnerId,
      requestExpiresAt: { $gt: new Date() },
      status: { $in: pendingAssignmentStatuses() }
    },
    {
      $set: {
        partnerId,
        status: "accepted",
        acceptedAt: new Date()
      }
    },
    { new: true }
  );
}

async function main() {
  const server = await MongoMemoryServer.create();
  try {
    await mongoose.connect(server.getUri(), { dbName: "apnaservo-race-audit" });
    const firstPartnerId = new mongoose.Types.ObjectId();
    const secondPartnerId = new mongoose.Types.ObjectId();
    const booking = await Booking.create({
      bookingCode: `RACE-${Date.now()}`,
      userId: new mongoose.Types.ObjectId(),
      serviceCategory: "ac",
      serviceName: "AC Repair",
      address: "Production audit address",
      status: "sent_to_partner",
      requestedPartners: [firstPartnerId, secondPartnerId],
      requestExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    const results = await Promise.all([
      claimBooking(booking._id, firstPartnerId),
      claimBooking(booking._id, secondPartnerId)
    ]);
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, "Exactly one partner must win a concurrent booking acceptance");

    const stored = await Booking.findById(booking._id).lean();
    assert.equal(stored.status, "accepted");
    assert.ok(stored.partnerId, "Accepted booking must store the winning partner");
    assert.equal(stored.requestedPartners.length, 2, "Requested partner list must remain available for loser invalidation events");

    const loserId = String(stored.partnerId) === String(firstPartnerId) ? secondPartnerId : firstPartnerId;
    assert.equal(await claimBooking(booking._id, loserId), null, "A losing partner must not be able to accept after assignment");

    const expiredBooking = await Booking.create({
      bookingCode: `EXPIRED-${Date.now()}`,
      userId: new mongoose.Types.ObjectId(),
      serviceCategory: "ac",
      serviceName: "AC Repair",
      address: "Expired audit address",
      status: "sent_to_partner",
      requestedPartners: [firstPartnerId],
      requestExpiresAt: new Date(Date.now() - 1)
    });
    assert.equal(await claimBooking(expiredBooking._id, firstPartnerId), null, "A request must not be accepted after its 10-minute window");
    await expireDueBookingRequests({ _id: expiredBooking._id });
    const closedBooking = await Booking.findById(expiredBooking._id).lean();
    assert.equal(closedBooking.status, "expired", "Expired partner request must close for the customer");
    assert.equal(closedBooking.requestedPartners.length, 0, "Expired request must be removed from every partner queue");
    assert.equal(closedBooking.expiryReason, "No partner accepted within 10 minutes");
    console.log("PASS concurrent booking acceptance has exactly one winner and one unavailable loser");
    console.log("PASS expired booking request cannot be accepted");
    console.log("PASS 10-minute expiry closes the booking and enables a clean retry");
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`FAIL booking acceptance race audit - ${error.message}`);
  process.exit(1);
});
