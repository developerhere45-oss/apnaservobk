const mongoose = require("mongoose");

const ACTIVE_REQUEST_STATUSES = new Set(["requested", "delivered", "viewed"]);
const TERMINAL_REQUEST_STATUSES = new Set(["accepted", "rejected", "expired", "cancelled"]);

function requestId() {
  return `PR-${new mongoose.Types.ObjectId().toString().toUpperCase()}`;
}

function requestIsActive(request) {
  return ACTIVE_REQUEST_STATUSES.has(String(request?.status || "").toLowerCase());
}

function requestIsTerminal(request) {
  return TERMINAL_REQUEST_STATUSES.has(String(request?.status || "").toLowerCase());
}

function partnerIdOf(partner) {
  return String(partner?._id || partner?.id || partner || "");
}

function partnerName(request) {
  return request?.partnerSnapshot?.name || "Partner";
}

function appendTimeline(booking, status, at, by, note = "") {
  if (!Array.isArray(booking.statusTimeline)) booking.statusTimeline = [];
  booking.statusTimeline.push({ status, at, by, note });
}

function routingCriteria(partner, match = {}) {
  const partnerId = partnerIdOf(partner);
  const distanceMeters = Number(match.distancesMeters?.[partnerId] || 0);
  const hasDistance = match.mode === "customer_location" && Number.isFinite(distanceMeters) && distanceMeters > 0;
  return {
    serviceMatched: true,
    partnerOnline: partner.isOnline === true,
    accountActive: partner.accountStatus === "active",
    partnerVerified: partner.isVerified === true,
    kycVerified: partner.kycStatus === "verified",
    trustedPartner: partner.trustStatus === "trusted",
    locationTrusted: partner.locationTrustStatus !== "suspicious",
    withinDispatchRadius: hasDistance,
    withinPartnerServiceRadius: hasDistance,
    distanceMeters: hasDistance ? Math.round(distanceMeters) : null,
    dispatchRadiusKm: Number(match.radiusKm || 0),
    dispatchMode: String(match.mode || "")
  };
}

function buildPartnerRequest({ booking, partner, match, source = "automatic", dispatchAttempt = 1, dispatchStage = 1, sentAt = new Date() }) {
  return {
    requestId: requestId(),
    partnerId: partner._id,
    partnerPublicId: partner.publicId || partner.partnerId || partner.partnerCode || "",
    partnerSnapshot: {
      name: partner.name || "Partner",
      phone: partner.phone || "",
      photoUrl: partner.photoUrl || partner.selfieUrl || "",
      // Partner profiles store serviceCategory as an array, while a request
      // snapshot represents the single service requested by this booking.
      // Passing the profile array into the embedded String field causes a
      // Mongoose CastError and aborts the entire confirmation/dispatch call.
      serviceCategory: String(booking?.serviceCategory || (Array.isArray(partner.serviceCategory)
        ? partner.serviceCategory[0]
        : partner.serviceCategory) || ""),
      rating: Number(partner.rating || 0),
      totalJobs: Number(partner.totalJobs || 0),
      wasOnline: partner.isOnline === true
    },
    routing: routingCriteria(partner, match),
    source,
    dispatchAttempt: Math.max(1, Number(dispatchAttempt || 1)),
    dispatchStage: Math.max(1, Number(dispatchStage || 1)),
    status: "requested",
    createdAt: sentAt,
    sentAt,
    expiresAt: booking.requestExpiresAt || null,
    notification: {
      pushStatus: "pending",
      pushSuccessCount: 0,
      pushFailureCount: 0,
      technicalDetails: ""
    }
  };
}

function addPartnerRequests(booking, partners, options = {}) {
  if (!Array.isArray(booking.partnerRequests)) booking.partnerRequests = [];
  const sentAt = options.sentAt || new Date();
  const requests = (partners || []).map((partner) => buildPartnerRequest({
    booking,
    partner,
    match: options.match,
    source: options.source,
    dispatchAttempt: options.dispatchAttempt,
    dispatchStage: options.dispatchStage,
    sentAt
  }));
  booking.partnerRequests.push(...requests);
  for (const request of requests) {
    appendTimeline(
      booking,
      "partner_request_sent",
      sentAt,
      options.actor || "system",
      `Request sent to ${partnerName(request)} (round ${request.dispatchStage})`
    );
  }
  return requests;
}

function findRequest(booking, { requestId: targetRequestId, partnerId, activeOnly = false } = {}) {
  const entries = Array.isArray(booking?.partnerRequests) ? booking.partnerRequests : [];
  const partnerIdText = partnerId ? String(partnerId) : "";
  const found = [...entries].reverse().find((entry) => {
    if (targetRequestId && String(entry.requestId) !== String(targetRequestId)) return false;
    if (partnerIdText && String(entry.partnerId || "") !== partnerIdText) return false;
    return !activeOnly || requestIsActive(entry);
  });
  return found || null;
}

function secondsBetween(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

function markRequestViewed(booking, partnerId, { at = new Date(), source = "booking_opened" } = {}) {
  const request = findRequest(booking, { partnerId, activeOnly: true });
  if (!request || request.viewedAt) return { changed: false, request };
  request.viewedAt = at;
  request.viewedSource = source;
  request.status = "viewed";
  appendTimeline(booking, "partner_request_viewed", at, "partner", `${partnerName(request)} viewed the request`);
  return { changed: true, request };
}

function markRequestResponse(booking, partnerId, status, { at = new Date(), reason = "" } = {}) {
  const request = findRequest(booking, { partnerId, activeOnly: true });
  if (!request) return { changed: false, request: null, cancelled: [] };
  request.status = status;
  request.respondedAt = at;
  request.responseTimeSeconds = secondsBetween(request.sentAt || request.createdAt, at);
  if (status === "rejected") request.rejectionReason = reason;
  appendTimeline(
    booking,
    status === "accepted" ? "partner_request_accepted" : "partner_request_rejected",
    at,
    "partner",
    status === "accepted"
      ? `${partnerName(request)} accepted the request`
      : `${partnerName(request)} rejected the request${reason ? `: ${reason}` : ""}`
  );

  const cancelled = [];
  if (status === "accepted") {
    for (const other of booking.partnerRequests || []) {
      if (String(other.partnerId || "") === String(partnerId) || !requestIsActive(other)) continue;
      other.status = "cancelled";
      other.cancelledAt = at;
      other.cancellationReason = `Booking accepted by ${partnerName(request)}`;
      cancelled.push(other);
      appendTimeline(booking, "partner_request_cancelled", at, "system", `Request to ${partnerName(other)} cancelled: booking accepted by another partner`);
    }
  }
  return { changed: true, request, cancelled };
}

function cancelOutstandingRequests(booking, { at = new Date(), reason = "Booking rerouted by admin" } = {}) {
  const cancelled = [];
  for (const request of booking.partnerRequests || []) {
    if (!requestIsActive(request)) continue;
    request.status = "cancelled";
    request.cancelledAt = at;
    request.cancellationReason = reason;
    cancelled.push(request);
    appendTimeline(booking, "partner_request_cancelled", at, "admin", `Request to ${partnerName(request)} cancelled: ${reason}`);
  }
  return cancelled;
}

function expireOutstandingRequests(booking, { at = new Date() } = {}) {
  const expired = [];
  for (const request of booking.partnerRequests || []) {
    if (!requestIsActive(request)) continue;
    request.status = "expired";
    request.expiredAt = at;
    request.expiryReason = "Request deadline reached without partner acceptance";
    expired.push(request);
    appendTimeline(booking, "partner_request_expired", at, "system", `Request to ${partnerName(request)} expired`);
  }
  return expired;
}

function recordNotificationResult(booking, requestIdToUpdate, result = {}, { at = new Date() } = {}) {
  const request = findRequest(booking, { requestId: requestIdToUpdate });
  if (!request) return { changed: false, request: null };
  const pushStatus = String(result.pushStatus || "failed").toLowerCase();
  request.notification = {
    notificationId: result.notificationId ? String(result.notificationId) : "",
    pushStatus,
    pushSuccessCount: Number(result.pushSuccessCount || 0),
    pushFailureCount: Number(result.pushFailureCount || 0),
    technicalDetails: String(result.pushError || "")
  };
  if (pushStatus === "sent") {
    request.deliveredAt = request.deliveredAt || at;
    if (request.status === "requested") request.status = "delivered";
    appendTimeline(booking, "partner_request_delivered", at, "system", `Request delivered to ${partnerName(request)}`);
  } else if (pushStatus === "failed" || pushStatus === "skipped") {
    request.failureReason = pushStatus === "skipped" ? "No active push notification token" : "Push notification failed";
    request.failureTechnicalDetails = String(result.pushError || "");
    request.failedAt = at;
    if (request.status === "requested") request.status = "failed";
    appendTimeline(booking, "partner_request_failed", at, "system", `Request to ${partnerName(request)} failed: ${request.failureReason}`);
  }
  return { changed: true, request };
}

function effectiveStatus(request, now = new Date()) {
  const status = String(request?.status || "requested").toLowerCase();
  if (status === "viewed" && !request.respondedAt && request.expiresAt && new Date(request.expiresAt).getTime() > now.getTime()) {
    return "not_responded";
  }
  return status;
}

module.exports = {
  ACTIVE_REQUEST_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  addPartnerRequests,
  cancelOutstandingRequests,
  effectiveStatus,
  expireOutstandingRequests,
  findRequest,
  markRequestResponse,
  markRequestViewed,
  recordNotificationResult,
  requestIsActive,
  requestIsTerminal,
  secondsBetween
};
