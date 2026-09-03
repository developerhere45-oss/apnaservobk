const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { Booking } = require("../src/models/Booking");
const Partner = require("../src/models/Partner");
const findNearbyPartners = require("../src/utils/findNearbyPartners");
const { addPartnerRequests, recordNotificationResult } = require("../src/utils/partnerRequestTracking");
const { dispatchableBookingStatuses } = require("../src/utils/bookingLifecycle");

function partner(uid, overrides = {}) {
  return {
    firebaseUid: uid,
    name: uid,
    phone: "9876543210",
    serviceCategory: ["ac"],
    isOnline: true,
    accountStatus: "active",
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted",
    locationTrustStatus: "trusted",
    location: { type: "Point", coordinates: [91.7362, 26.1445] },
    ...overrides
  };
}

async function main() {
  const memory = await MongoMemoryServer.create();
  try {
    await mongoose.connect(memory.getUri(), { dbName: "booking-confirmed-dispatch-audit" });
    const eligible = await Partner.create([
      partner("eligible-one"),
      partner("eligible-two", { location: { type: "Point", coordinates: [91.742, 26.149] }, fcmToken: "" }),
      partner("wrong-service", { serviceCategory: ["plumbing"] }),
      partner("invalid-partner", { isVerified: false, kycStatus: "pending_review" })
    ]);

    const match = await findNearbyPartners.withMetadata({
      serviceCategory: "ac",
      city: "Guwahati",
      lat: 26.1445,
      lng: 91.7362
    });
    assert.equal(match.partners.length, 2, "only eligible same-service partners must match");
    assert.deepEqual(new Set(match.partners.map((item) => item.firebaseUid)), new Set(["eligible-one", "eligible-two"]));

    const booking = await Booking.create({
      bookingId: "ASB-20260904-A1B2C3D4",
      bookingCode: "ASB-20260904-A1B2C3D4",
      userId: new mongoose.Types.ObjectId(),
      serviceCategory: "ac",
      serviceName: "AC Repair",
      address: "Production audit address, Guwahati",
      location: { type: "Point", coordinates: [91.7362, 26.1445] },
      status: "confirmed",
      requestExpiresAt: null,
      statusTimeline: [{ status: "confirmed", at: new Date(), by: "system" }]
    });

    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + 10 * 60 * 1000);
    const tracking = { requestExpiresAt: expiresAt, partnerRequests: [], statusTimeline: [] };
    const requests = addPartnerRequests(tracking, match.partners, {
      match,
      dispatchAttempt: 1,
      dispatchStage: 1,
      sentAt
    });
    const dispatched = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        partnerId: null,
        requestedPartners: { $size: 0 },
        status: { $in: dispatchableBookingStatuses() }
      },
      {
        $set: {
          status: "sent_to_partner",
          requestedPartners: match.partners.map((item) => item._id),
          partnerRequests: tracking.partnerRequests,
          dispatchMode: match.mode,
          dispatchRadiusKm: match.radiusKm,
          dispatchedAt: sentAt,
          requestExpiresAt: expiresAt
        },
        $push: { statusTimeline: { $each: tracking.statusTimeline } }
      },
      { new: true, runValidators: true }
    );
    assert.ok(dispatched, "confirmed booking must atomically enter the partner queue");
    assert.equal(dispatched.status, "sent_to_partner");
    assert.equal(dispatched.requestedPartners.length, 2);
    assert.equal(dispatched.partnerRequests.length, 2);
    assert.ok(dispatched.requestExpiresAt > dispatched.dispatchedAt, "expiry must start at dispatch time");

    const duplicate = await Booking.findOneAndUpdate(
      { _id: booking._id, requestedPartners: { $size: 0 }, status: { $in: dispatchableBookingStatuses() } },
      { $set: { status: "sent_to_partner" } },
      { new: true }
    );
    assert.equal(duplicate, null, "duplicate confirmation/dispatch must not create duplicate requests");

    const failedPush = recordNotificationResult(dispatched, requests[1].requestId, {
      pushStatus: "failed",
      pushFailureCount: 1,
      pushError: "simulated FCM failure"
    });
    assert.equal(failedPush.changed, true);
    await dispatched.save();
    const visibleAfterRestart = await Booking.findOne({
      _id: booking._id,
      requestedPartners: eligible[1]._id,
      status: "sent_to_partner",
      requestExpiresAt: { $gt: new Date() }
    });
    assert.ok(visibleAfterRestart, "FCM failure must not remove the durable partner dashboard request");

    await Partner.updateMany({}, { $set: { isOnline: false } });
    const noEligible = await findNearbyPartners.withMetadata({ serviceCategory: "ac", city: "Guwahati", lat: 26.1445, lng: 91.7362 });
    assert.equal(noEligible.partners.length, 0, "no-eligible-partner case must return an empty match without corrupting booking state");

    console.log("PASS confirmed booking dispatches atomically to multiple eligible partners");
    console.log("PASS wrong-service and invalid partners are excluded");
    console.log("PASS missing/failed FCM preserves the durable dashboard request");
    console.log("PASS duplicate dispatch is idempotent and app restart can recover the request");
    console.log("PASS no eligible partner returns safely");
  } finally {
    await mongoose.disconnect();
    await memory.stop();
  }
}

main().catch(async (error) => {
  console.error(`FAIL confirmed booking dispatch audit - ${error.stack || error.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
