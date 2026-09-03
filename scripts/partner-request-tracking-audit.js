const assert = require("assert");
const mongoose = require("mongoose");
const {
  addPartnerRequests,
  effectiveStatus,
  expireOutstandingRequests,
  markRequestResponse,
  markRequestViewed,
  recordNotificationResult
} = require("../src/utils/partnerRequestTracking");

function partner(name, options = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name,
    phone: "9876543210",
    serviceCategory: "ac_repair",
    rating: 4.8,
    totalJobs: 12,
    isOnline: true,
    accountStatus: "active",
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted",
    locationTrustStatus: "trusted",
    ...options
  };
}

function booking(expiresAt) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingCode: "AS-TRACKING-AUDIT",
    userId: new mongoose.Types.ObjectId(),
    requestExpiresAt: expiresAt,
    partnerRequests: [],
    statusTimeline: []
  };
}

function run() {
  const sentAt = new Date("2026-09-04T04:00:00.000Z");
  const expiresAt = new Date(sentAt.getTime() + 10 * 60 * 1000);
  const first = partner("Raj Kumar");
  const second = partner("Amit Services");
  const third = partner("QuickFix Partner");
  const record = booking(expiresAt);
  const requests = addPartnerRequests(record, [first, second, third], {
    match: {
      mode: "customer_location",
      radiusKm: 5,
      distancesMeters: {
        [String(first._id)]: 1200,
        [String(second._id)]: 1800,
        [String(third._id)]: 2400
      }
    },
    sentAt,
    dispatchAttempt: 1,
    dispatchStage: 1
  });
  assert.equal(requests.length, 3);
  assert.equal(record.statusTimeline.filter((event) => event.status === "partner_request_sent").length, 3);

  recordNotificationResult(record, requests[0].requestId, { pushStatus: "sent", pushSuccessCount: 1 }, { at: new Date(sentAt.getTime() + 2000) });
  recordNotificationResult(record, requests[1].requestId, { pushStatus: "failed", pushFailureCount: 1, pushError: "FCM unavailable" }, { at: new Date(sentAt.getTime() + 2500) });
  assert.equal(record.partnerRequests[0].status, "delivered");
  assert.equal(record.partnerRequests[1].status, "failed");
  assert.equal(record.partnerRequests[1].failureReason, "Push notification failed");

  const viewed = markRequestViewed(record, first._id, { at: new Date(sentAt.getTime() + 4000) });
  assert.equal(viewed.changed, true);
  assert.equal(effectiveStatus(viewed.request, new Date(sentAt.getTime() + 5000)), "not_responded");
  const rejected = markRequestResponse(record, first._id, "rejected", { at: new Date(sentAt.getTime() + 6000), reason: "Too far" });
  assert.equal(rejected.request.status, "rejected");
  assert.equal(rejected.request.rejectionReason, "Too far");

  const accepted = markRequestResponse(record, third._id, "accepted", { at: new Date(sentAt.getTime() + 8000) });
  assert.equal(accepted.request.status, "accepted");
  assert.equal(accepted.request.responseTimeSeconds, 8);
  assert.equal(markRequestResponse(record, third._id, "accepted").changed, false, "accepted request is idempotent");

  const expiring = booking(expiresAt);
  const expiringRequests = addPartnerRequests(expiring, [partner("Unresponsive Partner")], { sentAt, dispatchAttempt: 1, dispatchStage: 1 });
  const expired = expireOutstandingRequests(expiring, { at: expiresAt });
  assert.equal(expired.length, 1);
  assert.equal(expiringRequests[0].status, "expired");

  console.log("Partner request tracking audit passed");
}

run();
