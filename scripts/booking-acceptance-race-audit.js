const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Booking } = require("../src/models/Booking");
const { pendingAssignmentStatuses } = require("../src/utils/bookingLifecycle");

async function claimBooking(bookingId, partnerId) {
  return Booking.findOneAndUpdate(
    {
      _id: bookingId,
      partnerId: null,
      requestedPartners: partnerId,
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
      requestedPartners: [firstPartnerId, secondPartnerId]
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
    console.log("PASS concurrent booking acceptance has exactly one winner and one unavailable loser");
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`FAIL booking acceptance race audit - ${error.message}`);
  process.exit(1);
});
