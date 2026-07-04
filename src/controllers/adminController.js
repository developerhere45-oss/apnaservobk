const mongoose = require("mongoose");
const User = require("../models/User");
const Partner = require("../models/Partner");
const PartnerDocument = require("../models/PartnerDocument");
const PartnerUploadAsset = require("../models/PartnerUploadAsset");
const { Booking } = require("../models/Booking");
const Service = require("../models/Service");
const Review = require("../models/Review");
const ReviewDispute = require("../models/ReviewDispute");
const InAppNotification = require("../models/InAppNotification");
const AdminNotification = require("../models/AdminNotification");
const Payment = require("../models/Payment");
const BookingMessage = require("../models/BookingMessage");
const CustomerNoResponseReport = require("../models/CustomerNoResponseReport");
const LocationLog = require("../models/LocationLog");
const RevisitRequest = require("../models/RevisitRequest");
const TechnicianSos = require("../models/TechnicianSos");
const SupportTicket = require("../models/SupportTicket");
const AdminActivity = require("../models/AdminActivity");
const cache = require("../config/cache");
const { recomputePartnerRating } = require("../utils/ratingAggregation");
const { emitAdminEvent, emitNewBookingToPartners } = require("../sockets/bookingSocket");
const { reliableNotify } = require("../utils/reliableNotify");
const { activeDeviceTokens, tokenHash } = require("../utils/notificationTokens");
const findNearbyPartners = require("../utils/findNearbyPartners");
const { serviceCategoryVariants, serviceLabel } = require("../utils/serviceCategory");
const { pendingAssignmentStatuses } = require("../utils/bookingLifecycle");
const { partnerAssetUrl, verifyPartnerAssetToken } = require("../utils/partnerUploadAssets");

function iso(value) {
  return value ? new Date(value).toISOString() : "";
}

function money(value) {
  return Number(value || 0);
}

function id(value) {
  return value ? String(value) : "";
}

function objectId(value) {
  const raw = String(value || "").trim();
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

function regex(value) {
  const text = String(value || "").trim();
  return text ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function includesText(value, query) {
  const text = String(value || "").toLowerCase();
  const needle = String(query || "").toLowerCase();
  return needle ? text.includes(needle) : true;
}

function ticketCode() {
  return `TCK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
}

function normalizeAccountStatus(value) {
  const status = String(value || "active").toLowerCase();
  if (status === "active") return "Active";
  if (status === "suspended") return "Suspended";
  if (status === "blocked" || status === "deleted" || status === "deletion_requested") return "Blocked";
  return status.replace(/_/g, " ");
}

function coordinates(location) {
  const list = location?.coordinates || [];
  return {
    lng: Number(list[0] || 0),
    lat: Number(list[1] || 0)
  };
}

function primaryAddress(user) {
  const saved = Array.isArray(user.savedAddresses) ? user.savedAddresses : [];
  const defaultAddress = saved.find((entry) => entry.isDefault) || saved[0];
  if (defaultAddress?.address) return defaultAddress.address;
  return user.address || "";
}

function savedAddresses(user) {
  const saved = Array.isArray(user.savedAddresses) ? user.savedAddresses : [];
  if (saved.length) {
    return saved.map((entry) => ({
      id: id(entry._id),
      label: entry.label || "Saved",
      address: entry.address || "",
      city: entry.city || user.city || "",
      isDefault: Boolean(entry.isDefault),
      location: coordinates(entry.location)
    }));
  }
  if (!user.address) return [];
  return [{
    id: "primary",
    label: "Primary",
    address: user.address,
    city: user.city || "",
    isDefault: true,
    location: coordinates(user.location)
  }];
}

function summarizeDeviceInfo(deviceInfo) {
  if (!deviceInfo || typeof deviceInfo !== "object" || Array.isArray(deviceInfo)) return "";
  const values = [
    deviceInfo.platform,
    deviceInfo.os,
    deviceInfo.osVersion,
    deviceInfo.appVersion,
    deviceInfo.model,
    deviceInfo.manufacturer
  ].filter(Boolean);
  return values.length ? values.join(" / ") : JSON.stringify(deviceInfo);
}

function bookingTime(booking, statuses) {
  const wanted = new Set(statuses);
  const hit = (booking.statusTimeline || []).find((entry) => wanted.has(String(entry.status || "").toLowerCase()));
  return hit?.at || null;
}

function bookingTimeline(booking, payments = [], messages = []) {
  const events = [];
  if (booking.createdAt) {
    events.push({
      event: "Booking created",
      at: booking.createdAt,
      by: "user",
      note: `${booking.serviceName || booking.serviceCategory || "Service"} requested`
    });
  }
  for (const entry of booking.statusTimeline || []) {
    events.push({
      event: String(entry.status || "status_update").replace(/_/g, " "),
      at: entry.at || booking.updatedAt,
      by: entry.by || "system",
      note: ""
    });
  }
  for (const entry of booking.quoteHistory || []) {
    events.push({
      event: String(entry.kind || "quote_update").replace(/_/g, " "),
      at: entry.at,
      by: entry.by || "system",
      note: [entry.amount ? `Amount Rs ${entry.amount}` : "", entry.message || ""].filter(Boolean).join(" - ")
    });
  }
  for (const payment of payments) {
    events.push({
      event: `Payment ${payment.status || "created"}`,
      at: payment.createdAt,
      by: "payment",
      note: `${payment.currency || "INR"} ${payment.amount || 0}`
    });
  }
  for (const message of messages) {
    events.push({
      event: "Chat message",
      at: message.createdAt,
      by: message.senderRole || "chat",
      note: message.message || ""
    });
  }
  return events
    .filter((entry) => entry.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map((entry) => ({ ...entry, at: iso(entry.at) }));
}

function serializeBookingHistory(booking, payments = [], messages = []) {
  const completedAt = booking.completedAt || bookingTime(booking, ["completed"]);
  return {
    id: id(booking._id),
    bookingId: booking.bookingCode || id(booking._id),
    serviceCategory: booking.serviceCategory || "",
    serviceName: booking.serviceName || "",
    dateTimeBooked: iso(booking.createdAt),
    scheduledDateTime: booking.slot || iso(booking.expectedArrivalAt),
    jobStartTime: iso(bookingTime(booking, ["started"])),
    jobCompletionTime: iso(completedAt),
    bookingStatus: booking.status || "",
    assignedPartnerName: booking.partnerSnapshot?.name || "",
    assignedPartnerMobileNumber: booking.partnerSnapshot?.phone || "",
    customerAddress: booking.address || "",
    customerNotes: [booking.issue || "", booking.emergency?.notes || ""].filter(Boolean).join(" | "),
    finalServiceCost: money(booking.finalAmount || booking.quoteAmount || booking.price),
    paymentStatus: booking.paymentStatus || "",
    timeline: bookingTimeline(booking, payments, messages)
  };
}

function serializeSupportTicket(ticket) {
  return {
    id: id(ticket._id),
    ticketId: ticket.ticketCode || id(ticket._id),
    userId: id(ticket.userId),
    partnerId: id(ticket.partnerId),
    bookingId: id(ticket.bookingId),
    bookingCode: ticket.bookingCode || "",
    userName: ticket.userName || "",
    partnerName: ticket.partnerName || "",
    mobileNumber: ticket.mobileNumber || "",
    email: ticket.email || "",
    ticketCategory: ticket.category || "general",
    priority: ticket.priority || "normal",
    status: ticket.status || "open",
    source: ticket.source || "ai_support",
    createdDateTime: iso(ticket.createdAt),
    lastUpdated: iso(ticket.lastUpdatedAt || ticket.updatedAt),
    complaint: ticket.complaint || "",
    aiSummary: ticket.aiSummary || "",
    conversationHistory: (ticket.conversation || []).map((entry) => ({
      id: id(entry._id),
      senderRole: entry.senderRole || "",
      senderName: entry.senderName || "",
      message: entry.message || "",
      attachments: entry.attachments || [],
      createdAt: iso(entry.createdAt)
    })),
    ticketTimeline: (ticket.timeline || []).map((entry) => ({
      event: entry.event || "",
      by: entry.by || "",
      note: entry.note || "",
      at: iso(entry.at)
    })),
    adminReplies: (ticket.adminReplies || []).map((entry) => ({
      id: id(entry._id),
      senderRole: entry.senderRole || "admin",
      senderName: entry.senderName || "",
      message: entry.message || "",
      attachments: entry.attachments || [],
      createdAt: iso(entry.createdAt)
    })),
    resolutionNotes: ticket.resolutionNotes || "",
    internalNotes: (ticket.internalNotes || []).map((entry) => ({
      id: id(entry._id),
      note: entry.note || "",
      addedBy: entry.addedBy || "",
      addedAt: iso(entry.addedAt)
    })),
    attachments: ticket.attachments || [],
    assignedTo: ticket.assignedTo || "",
    escalatedTo: ticket.escalatedTo || ""
  };
}

function serializePayment(payment) {
  return {
    id: id(payment._id),
    bookingId: id(payment.bookingId),
    amount: money(payment.amount),
    currency: payment.currency || "INR",
    status: payment.status || "",
    razorpayOrderId: payment.razorpayOrderId || "",
    razorpayPaymentId: payment.razorpayPaymentId || "",
    createdAt: iso(payment.createdAt),
    updatedAt: iso(payment.updatedAt)
  };
}

function serializeAdminActivity(activity) {
  return {
    id: id(activity._id),
    eventName: activity.eventName || "",
    category: activity.category || "",
    title: activity.title || "",
    detail: activity.detail || "",
    bookingId: id(activity.bookingId),
    bookingCode: activity.bookingCode || "",
    userId: id(activity.userId),
    partnerId: id(activity.partnerId),
    ticketId: activity.ticketId || "",
    complaintId: activity.complaintId || "",
    status: activity.status || "",
    amount: money(activity.amount),
    actorRole: activity.actorRole || "",
    actorName: activity.actorName || "",
    source: activity.source || "",
    payload: activity.payload || {},
    createdAt: iso(activity.createdAt),
    updatedAt: iso(activity.updatedAt)
  };
}

function serializeDispute(dispute) {
  return {
    id: String(dispute._id),
    reviewId: String(dispute.reviewId),
    bookingId: String(dispute.bookingId),
    bookingCode: dispute.bookingCode || "",
    partnerId: String(dispute.partnerId),
    userId: String(dispute.userId),
    reason: dispute.reason,
    details: dispute.details || "",
    status: dispute.status,
    resolutionNote: dispute.resolutionNote || "",
    resolvedBy: dispute.resolvedBy || "",
    createdAt: dispute.createdAt ? dispute.createdAt.toISOString() : "",
    resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : ""
  };
}

function startOfToday() {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

function bookingAmount(booking) {
  return money(booking?.finalAmount || booking?.quoteAmount || booking?.price);
}

function bookingRow(booking) {
  return {
    id: id(booking._id),
    bookingCode: booking.bookingCode || id(booking._id),
    userName: booking.userSnapshot?.name || "",
    userMobile: booking.userSnapshot?.phone || "",
    serviceCategory: booking.serviceCategory || "",
    serviceName: booking.serviceName || booking.serviceCategory || "",
    partnerName: booking.partnerSnapshot?.name || "",
    partnerMobile: booking.partnerSnapshot?.phone || "",
    bookingDateTime: iso(booking.createdAt),
    scheduledDateTime: booking.slot || iso(booking.expectedArrivalAt),
    jobStartTime: iso(bookingTime(booking, ["started"])),
    jobCompletionTime: iso(booking.completedAt || bookingTime(booking, ["completed"])),
    status: booking.status || "",
    customerAddress: booking.address || "",
    customerNotes: [booking.issue || "", booking.emergency?.notes || ""].filter(Boolean).join(" | "),
    finalServiceCost: bookingAmount(booking),
    paymentStatus: booking.paymentStatus || "",
    city: booking.city || ""
  };
}

function partnerRow(partner, bookingCount = 0, profilePhoto = "") {
  const approved = partner.isVerified === true && partner.kycStatus === "verified" && partner.trustStatus === "trusted";
  const blocked = partner.accountStatus === "blocked" || partner.accountStatus === "suspended" || partner.trustStatus === "suspended";
  return {
    id: id(partner._id),
    code: partner.partnerCode || id(partner._id),
    name: partner.name || "",
    phone: partner.phone || "",
    email: partner.email || "",
    profilePhoto: profilePhoto || partner.photoUrl || partner.selfieUrl || "",
    dateOfBirth: partner.dateOfBirth || "",
    gender: partner.gender || "",
    residentialAddress: partner.residentialAddress || "",
    services: (partner.serviceCategory || []).join(", "),
    profession: (partner.serviceCategory || []).join(", "),
    yearsOfExperience: Number(partner.yearsOfExperience || 0),
    workingAreas: (partner.workingAreas || []).join(", ") || partner.serviceArea || "",
    languagesKnown: (partner.languagesKnown || []).join(", "),
    city: partner.city || "",
    state: partner.state || "",
    pinCode: partner.pinCode || "",
    emergencyContactNumber: partner.emergencyContactNumber || "",
    serviceArea: partner.serviceArea || "",
    online: Boolean(partner.isOnline),
    totalBookings: bookingCount,
    approval: blocked ? "Blocked" : (approved ? "Approved" : (partner.kycStatus === "rejected" ? "Denied" : "Waiting Approval")),
    isVerified: Boolean(partner.isVerified),
    kyc: partner.kycStatus || "",
    trust: partner.trustStatus || "",
    status: blocked ? "blocked" : (partner.accountStatus || "active"),
    rating: Number(partner.rating || 0),
    approvalVersion: Number(partner.approvalVersion || 0),
    approvedAt: iso(partner.approvedAt),
    rejectedAt: iso(partner.rejectedAt),
    rejectionReason: partner.rejectionReason || "",
    joinedAt: iso(partner.createdAt)
  };
}

function deviceRowsForOwner(owner, ownerType) {
  const ownerId = id(owner?._id);
  const ownerName = owner?.name || (ownerType === "partner" ? "ApnaServo Partner" : "ApnaServo Customer");
  const ownerPhone = owner?.phone || "";
  const ownerEmail = owner?.email || "";
  const rows = [];
  const seenTokens = new Set();
  for (const device of owner?.deviceTokens || []) {
    if (device?.token) seenTokens.add(String(device.token));
    if (!device?.isActive) continue;
    const deviceId = id(device._id) || device.deviceId || device.tokenHash || "";
    rows.push({
      id: `${ownerType}:${ownerId}:${deviceId}`,
      ownerType,
      ownerId,
      ownerName,
      mobileNumber: ownerPhone,
      email: ownerEmail,
      platform: device.platform || "android",
      appType: device.appType || ownerType,
      deviceId: device.deviceId || "",
      tokenHash: device.tokenHash || (device.token ? tokenHash(device.token) : ""),
      status: "active",
      active: Boolean(device.isActive),
      createdAt: iso(device.createdAt),
      lastUpdatedAt: iso(device.lastUpdatedAt)
    });
  }
  if (owner?.fcmToken && !seenTokens.has(String(owner.fcmToken))) {
    rows.push({
      id: `${ownerType}:${ownerId}:legacy`,
      ownerType,
      ownerId,
      ownerName,
      mobileNumber: ownerPhone,
      email: ownerEmail,
      platform: "android",
      appType: ownerType,
      deviceId: "legacy",
      tokenHash: tokenHash(owner.fcmToken),
      status: "active",
      active: true,
      createdAt: "",
      lastUpdatedAt: ""
    });
  }
  return rows;
}

async function deactivateAdminDevice(targetId) {
  const [ownerType, ownerId, deviceIdentifier] = String(targetId || "").split(":");
  if (!["user", "partner"].includes(ownerType) || !objectId(ownerId) || !deviceIdentifier) {
    const error = new Error("Invalid device target");
    error.status = 400;
    throw error;
  }
  const Model = ownerType === "partner" ? Partner : User;
  const owner = await Model.findById(ownerId);
  if (!owner) {
    const error = new Error(`${ownerType === "partner" ? "Partner" : "User"} not found`);
    error.status = 404;
    throw error;
  }
  let removed = false;
  if (deviceIdentifier === "legacy") {
    removed = Boolean(owner.fcmToken);
    owner.fcmToken = "";
  } else {
    for (const device of owner.deviceTokens || []) {
      if (
        id(device._id) === deviceIdentifier
        || String(device.deviceId || "") === deviceIdentifier
        || String(device.tokenHash || "") === deviceIdentifier
      ) {
        device.isActive = false;
        device.lastUpdatedAt = new Date();
        if (owner.fcmToken && (String(owner.fcmToken) === String(device.token || "") || tokenHash(owner.fcmToken) === String(device.tokenHash || ""))) {
          owner.fcmToken = "";
        }
        removed = true;
      }
    }
  }
  if (!removed) {
    const error = new Error("Device not found or already deleted");
    error.status = 404;
    throw error;
  }
  await owner.save();
  return {
    ownerType,
    ownerId,
    ownerName: owner.name || "",
    deviceIdentifier
  };
}

function partnerNotificationRecipient(partner) {
  if (!partner) return null;
  const tokens = activeDeviceTokens(partner, "partner").map((device) => device.token);
  return {
    role: "partner",
    partnerId: partner._id,
    firebaseUid: partner.firebaseUid,
    token: tokens[0] || partner.fcmToken,
    tokens,
    phone: partner.phone
  };
}

function userNotificationRecipient(user) {
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

function approvedPartnerFilter(extra = {}) {
  return {
    accountStatus: "active",
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted",
    ...extra
  };
}

function smartPriority(booking) {
  if (booking.emergency?.isEmergency || booking.emergency?.priority === "critical") return "High Priority";
  const createdAt = booking.createdAt ? new Date(booking.createdAt).getTime() : Date.now();
  const ageHours = (Date.now() - createdAt) / (60 * 60 * 1000);
  if (ageHours >= 4) return "High Priority";
  if (ageHours >= 1) return "Medium Priority";
  return "Low Priority";
}

function ageLabel(value) {
  const time = value ? new Date(value).getTime() : Date.now();
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function smartStatus(booking) {
  if (booking.partnerId) return "Assigned";
  if ((booking.requestedPartners || []).length) return "Sent to Partner";
  return "No Partner";
}

function smartBookingRow(booking) {
  return {
    id: id(booking._id),
    bookingCode: booking.bookingCode || id(booking._id),
    customerName: booking.userSnapshot?.name || "Customer",
    customerMobile: booking.userSnapshot?.phone || "",
    serviceCategory: booking.serviceCategory || "",
    serviceName: booking.serviceName || serviceLabel(booking.serviceCategory),
    area: booking.city || "Guwahati",
    address: booking.address || "",
    bookingDateTime: iso(booking.createdAt),
    scheduledDateTime: booking.slot || iso(booking.expectedArrivalAt),
    timeAgo: ageLabel(booking.createdAt),
    priority: smartPriority(booking),
    status: smartStatus(booking),
    rawStatus: booking.status || "",
    partnerName: booking.partnerSnapshot?.name || "",
    requestedPartnersCount: (booking.requestedPartners || []).length,
    finalServiceCost: bookingAmount(booking),
    paymentStatus: booking.paymentStatus || ""
  };
}

function smartPartnerRow(partner, activeJobs = 0) {
  return {
    id: id(partner._id),
    partnerCode: partner.partnerCode || id(partner._id),
    name: partner.name || "ApnaServo Partner",
    phone: partner.phone || "",
    email: partner.email || "",
    serviceCategory: (partner.serviceCategory || []).join(", "),
    serviceLabel: (partner.serviceCategory || []).map(serviceLabel).join(", "),
    area: partner.serviceArea || partner.city || "Guwahati",
    city: partner.city || "",
    rating: Number(partner.rating || 0),
    totalJobs: Number(partner.totalJobs || 0),
    activeJobs,
    isOnline: Boolean(partner.isOnline),
    status: partner.isOnline ? "Available" : "Offline",
    verificationStatus: partner.isVerified && partner.kycStatus === "verified" && partner.trustStatus === "trusted" ? "Verified" : "Review",
    photoUrl: partner.photoUrl || "",
    joinedAt: iso(partner.createdAt)
  };
}

function smartComplaintRow(ticket) {
  return {
    id: id(ticket._id),
    ticketId: ticket.ticketCode || id(ticket._id),
    bookingId: id(ticket.bookingId),
    bookingCode: ticket.bookingCode || "",
    customerName: ticket.userName || ticket.partnerName || "Customer",
    mobileNumber: ticket.mobileNumber || "",
    category: ticket.category || "complaint",
    priority: ticket.priority || "normal",
    status: ticket.status || "open",
    createdAt: iso(ticket.createdAt),
    lastUpdated: iso(ticket.lastUpdatedAt || ticket.updatedAt),
    complaint: ticket.complaint || ""
  };
}

function smartRebookingRow(request) {
  return {
    id: id(request._id),
    bookingId: id(request.bookingId),
    bookingCode: request.bookingCode || "",
    partnerId: id(request.partnerId),
    status: request.status || "",
    reason: request.reason || "",
    message: request.message || "",
    requestedAt: iso(request.requestedAt || request.createdAt)
  };
}

async function activeJobCountByPartner(partnerIds) {
  if (!partnerIds.length) return new Map();
  const rows = await Booking.aggregate([
    { $match: { partnerId: { $in: partnerIds }, status: { $in: ["accepted", "on_the_way", "arrived", "started", "amount_pending"] } } },
    { $group: { _id: "$partnerId", total: { $sum: 1 } } }
  ]);
  return new Map(rows.map((entry) => [id(entry._id), Number(entry.total || 0)]));
}

function bookingCoordinates(booking) {
  const coordinatesList = booking.location?.coordinates || [];
  return {
    lng: Number(coordinatesList[0] || 91.7362),
    lat: Number(coordinatesList[1] || 26.1445)
  };
}

async function availablePartnersForBooking(booking, { partnerIds = [], onlineOnly = false, limit = 30 } = {}) {
  const ids = (Array.isArray(partnerIds) ? partnerIds : [])
    .map((value) => objectId(value))
    .filter(Boolean);
  if (ids.length) {
    return Partner.find({ _id: { $in: ids }, ...approvedPartnerFilter() }).limit(limit);
  }

  let partners = [];
  if (onlineOnly) {
    const { lat, lng } = bookingCoordinates(booking);
    partners = await findNearbyPartners({
      serviceCategory: booking.serviceCategory,
      city: booking.city,
      lat,
      lng
    });
  }

  if (partners.length) return partners.slice(0, limit);

  const categories = serviceCategoryVariants(booking.serviceCategory);
  const cityMatcher = regex(booking.city || "Guwahati");
  return Partner.find({
    ...approvedPartnerFilter(onlineOnly ? { isOnline: true } : {}),
    serviceCategory: { $in: categories },
    ...(cityMatcher ? { $or: [{ city: cityMatcher }, { serviceArea: cityMatcher }, { workingAreas: cityMatcher }] } : {})
  })
    .sort({ isOnline: -1, rating: -1, totalJobs: -1, updatedAt: -1 })
    .limit(limit);
}

async function smartAssignmentDashboard(req, res, next) {
  try {
    const search = String(req.query.search || "").trim();
    const service = String(req.query.service || "").trim();
    const area = String(req.query.area || "").trim();
    const serviceFilter = service ? { serviceCategory: { $in: serviceCategoryVariants(service) } } : {};
    const areaFilter = area ? { city: regex(area) } : {};
    const searchFilter = search
      ? {
        $or: [
          { bookingCode: regex(search) },
          { serviceName: regex(search) },
          { "userSnapshot.name": regex(search) },
          { "userSnapshot.phone": regex(search) }
        ]
      }
      : {};

    const pendingQuery = {
      partnerId: null,
      status: { $in: pendingAssignmentStatuses() },
      ...serviceFilter,
      ...areaFilter,
      ...searchFilter
    };

    const [
      pendingBookings,
      pendingBookingsCount,
      rebookingRequests,
      rebookingRequestsCount,
      openComplaints,
      openComplaintsCount,
      availablePartners,
      totalAvailablePartners
    ] = await Promise.all([
      Booking.find(pendingQuery).sort({ "emergency.isEmergency": -1, createdAt: 1 }).limit(60),
      Booking.countDocuments(pendingQuery),
      RevisitRequest.find({ status: { $in: ["open", "partner_notified", "scheduled"] } }).sort({ createdAt: -1 }).limit(20),
      RevisitRequest.countDocuments({ status: { $in: ["open", "partner_notified", "scheduled"] } }),
      SupportTicket.find({ status: { $in: ["open", "assigned", "in_progress", "reopened", "escalated"] } }).sort({ lastUpdatedAt: -1, createdAt: -1 }).limit(30),
      SupportTicket.countDocuments({ status: { $in: ["open", "assigned", "in_progress", "reopened", "escalated"] } }),
      Partner.find(approvedPartnerFilter()).sort({ isOnline: -1, rating: -1, updatedAt: -1 }).limit(30),
      Partner.countDocuments(approvedPartnerFilter({ isOnline: true }))
    ]);

    const partnerIds = availablePartners.map((partner) => partner._id);
    const activeCounts = await activeJobCountByPartner(partnerIds);
    const partnerRows = availablePartners.map((partner) => smartPartnerRow(partner, activeCounts.get(id(partner._id)) || 0));
    const idlePartnerCount = partnerRows.filter((partner) => partner.isOnline && partner.activeJobs === 0).length;

    return res.json({
      generatedAt: new Date().toISOString(),
      metrics: {
        pendingBookings: pendingBookingsCount,
        rebookingRequests: rebookingRequestsCount,
        openComplaints: openComplaintsCount,
        partnersIdle: idlePartnerCount,
        partnersAvailable: totalAvailablePartners
      },
      pendingBookings: pendingBookings.map(smartBookingRow),
      partners: partnerRows,
      rebookingRequests: rebookingRequests.map(smartRebookingRow),
      complaints: openComplaints.map(smartComplaintRow),
      escalationRules: [
        { priority: "High Priority", minutes: 15 },
        { priority: "Medium Priority", minutes: 30 },
        { priority: "Low Priority", minutes: 60 }
      ]
    });
  } catch (error) {
    return next(error);
  }
}

async function forwardBookingToPartners({ booking, partners, reason = "Admin manual assignment", mode = "manual" }) {
  const now = new Date();
  const partnerIds = [...new Set(partners.map((partner) => id(partner._id)).filter(Boolean))];
  if (!partnerIds.length) {
    return { booking, partnerIds: [], addedPartnerIds: [] };
  }

  const currentRequested = new Set((booking.requestedPartners || []).map((partnerId) => id(partnerId)));
  const addedPartnerIds = partnerIds.filter((partnerId) => !currentRequested.has(partnerId));
  const requestedIds = [...new Set([...currentRequested, ...partnerIds])].map((partnerId) => new mongoose.Types.ObjectId(partnerId));
  const forwardedPartners = partners.filter((partner) => partnerIds.includes(id(partner._id)));

  booking.requestedPartners = requestedIds;
  booking.rejectedPartners = (booking.rejectedPartners || []).filter((partnerId) => !partnerIds.includes(id(partnerId)));
  booking.status = "sent_to_partner";
  booking.statusTimeline.push({ status: mode === "bulk" ? "admin_bulk_forwarded" : "admin_forwarded", at: now, by: "admin" });
  booking.statusTimeline.push({ status: "sent_to_partner", at: now, by: "admin" });
  await booking.save();

  emitNewBookingToPartners(booking, forwardedPartners);
  emitAdminEvent("booking:admin_forwarded", {
    ...smartBookingRow(booking),
    assignedPartnerIds: partnerIds,
    addedPartnerIds,
    partnerCount: partnerIds.length,
    reason,
    mode
  });

  await reliableNotify({
    recipients: forwardedPartners.map(partnerNotificationRecipient),
    title: "Booking assigned by ApnaServo",
    body: `${booking.serviceName || serviceLabel(booking.serviceCategory)} booking ${booking.bookingCode} is available in ${booking.city || "your area"}. Accept it from the Partner App.`,
    category: "booking_request",
    priority: smartPriority(booking).startsWith("High") ? "high" : "normal",
    data: {
      type: "booking:admin_forwarded",
      targetApp: "partner",
      actionType: "OPEN_BOOKING",
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      serviceCategory: booking.serviceCategory,
      mode
    },
    smsBody: `ApnaServo: Booking ${booking.bookingCode} for ${booking.serviceName || booking.serviceCategory} is available. Open Partner App to accept.`
  });

  const user = await User.findById(booking.userId);
  await reliableNotify({
    recipients: [userNotificationRecipient(user)],
    title: "Partner assignment in progress",
    body: `We have forwarded booking ${booking.bookingCode} to available partners in your area.`,
    category: "booking_status",
    priority: "normal",
    data: {
      type: "booking:admin_forwarded",
      targetApp: "user",
      actionType: "OPEN_BOOKING",
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      status: booking.status
    }
  });

  return { booking, partnerIds, addedPartnerIds };
}

async function smartAssignBooking(req, res, next) {
  try {
    const bookingId = String(req.body?.bookingId || "").trim();
    const mode = String(req.body?.mode || "area").trim();
    const reason = String(req.body?.reason || "Admin smart assignment").trim();
    const partnerIds = Array.isArray(req.body?.partnerIds) ? req.body.partnerIds : [];
    if (!bookingId) return res.status(400).json({ message: "bookingId is required" });

    const booking = await Booking.findOne({
      $or: [
        { _id: objectId(bookingId) || undefined },
        { bookingCode: bookingId }
      ].filter((entry) => Object.values(entry)[0])
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.partnerId) return res.status(409).json({ message: "Booking already has an assigned partner" });
    if (!pendingAssignmentStatuses().includes(String(booking.status || ""))) {
      return res.status(409).json({ message: `Booking cannot be forwarded while status is ${booking.status}` });
    }

    const partners = await availablePartnersForBooking(booking, {
      partnerIds,
      onlineOnly: mode !== "individual",
      limit: mode === "individual" ? 10 : 30
    });
    if (!partners.length) {
      return res.status(404).json({ message: "No approved partners found for this booking area/service" });
    }

    const result = await forwardBookingToPartners({ booking, partners, reason, mode });
    return res.json({
      ok: true,
      booking: smartBookingRow(result.booking),
      partners: partners.map((partner) => smartPartnerRow(partner)),
      assignedPartnerIds: result.partnerIds,
      addedPartnerIds: result.addedPartnerIds
    });
  } catch (error) {
    return next(error);
  }
}

async function smartBulkAssignPending(req, res, next) {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 25), 50));
    const service = String(req.body?.service || "").trim();
    const area = String(req.body?.area || "").trim();
    const query = {
      partnerId: null,
      status: { $in: pendingAssignmentStatuses() },
      ...(service ? { serviceCategory: { $in: serviceCategoryVariants(service) } } : {}),
      ...(area ? { city: regex(area) } : {})
    };
    const bookings = await Booking.find(query).sort({ "emergency.isEmergency": -1, createdAt: 1 }).limit(limit);
    const results = [];

    for (const booking of bookings) {
      const partners = await availablePartnersForBooking(booking, { onlineOnly: true, limit: 15 });
      if (!partners.length) {
        results.push({ bookingId: id(booking._id), bookingCode: booking.bookingCode, ok: false, message: "No approved online partners found" });
        continue;
      }
      const result = await forwardBookingToPartners({
        booking,
        partners,
        reason: "Admin bulk auto assignment",
        mode: "bulk"
      });
      results.push({
        bookingId: id(result.booking._id),
        bookingCode: result.booking.bookingCode,
        ok: true,
        partnerCount: result.partnerIds.length,
        addedPartnerCount: result.addedPartnerIds.length
      });
    }

    return res.json({
      ok: true,
      processed: results.length,
      forwarded: results.filter((entry) => entry.ok).length,
      results
    });
  } catch (error) {
    return next(error);
  }
}

function paymentRow(payment) {
  return {
    id: id(payment._id),
    bookingId: id(payment.bookingId?._id || payment.bookingId),
    bookingCode: payment.bookingId?.bookingCode || "",
    userName: payment.userId?.name || "",
    userMobile: payment.userId?.phone || "",
    partnerName: payment.partnerId?.name || "",
    partnerMobile: payment.partnerId?.phone || "",
    amount: money(payment.amount),
    currency: payment.currency || "INR",
    status: payment.status || "",
    razorpayOrderId: payment.razorpayOrderId || "",
    razorpayPaymentId: payment.razorpayPaymentId || "",
    createdAt: iso(payment.createdAt),
    updatedAt: iso(payment.updatedAt)
  };
}

async function bookingCountByPartner(partnerIds) {
  if (!partnerIds.length) return new Map();
  const counts = await Booking.aggregate([
    { $match: { partnerId: { $in: partnerIds } } },
    { $group: { _id: "$partnerId", total: { $sum: 1 } } }
  ]);
  return new Map(counts.map((entry) => [id(entry._id), entry.total]));
}

async function dashboard(req, res, next) {
  try {
    const today = startOfToday();
    const [
      totalUsers,
      activeUsers,
      newUsersToday,
      totalPartners,
      activePartners,
      pendingPartnerApprovals,
      blockedPartners,
      totalBookings,
      completedBookings,
      cancelledBookings,
      pendingBookings,
      processingBookings,
      openReviewDisputes,
      resolvedReviewDisputes,
      openSupportTickets,
      resolvedSupportTickets,
      payments,
      pendingPayments,
      recentBookings,
      recentDisputes,
      recentTickets,
      recentPayments,
      recentActivity,
      amountBookings
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ accountStatus: "active" }),
      User.countDocuments({ createdAt: { $gte: today } }),
      Partner.countDocuments(),
      Partner.countDocuments({ accountStatus: "active", trustStatus: { $ne: "suspended" } }),
      Partner.countDocuments({ kycStatus: { $in: ["missing", "submitted", "pending_review"] } }),
      Partner.countDocuments({ $or: [{ trustStatus: "suspended" }, { accountStatus: { $ne: "active" } }] }),
      Booking.countDocuments(),
      Booking.countDocuments({ status: "completed" }),
      Booking.countDocuments({ status: { $in: ["cancelled", "canceled"] } }),
      Booking.countDocuments({ status: { $in: ["pending", "sent_to_partner", "amount_pending"] } }),
      Booking.countDocuments({ status: { $in: ["accepted", "on_the_way", "arrived", "started"] } }),
      ReviewDispute.countDocuments({ status: { $in: ["open", "reviewing"] } }),
      ReviewDispute.countDocuments({ status: { $in: ["accepted", "rejected"] } }),
      SupportTicket.countDocuments({ status: { $in: ["open", "assigned", "in_progress", "waiting_on_customer", "reopened", "escalated"] } }),
      SupportTicket.countDocuments({ status: { $in: ["resolved", "closed"] } }),
      Payment.find().select("amount status"),
      Payment.find({ status: { $in: ["created", "failed"] } }).select("amount status"),
      Booking.find().sort({ createdAt: -1 }).limit(8),
      ReviewDispute.find().sort({ createdAt: -1 }).limit(6),
      SupportTicket.find().sort({ lastUpdatedAt: -1, createdAt: -1 }).limit(6),
      Payment.find().sort({ createdAt: -1 }).limit(8).populate("partnerId", "name phone").populate("userId", "name phone").populate("bookingId", "bookingCode serviceName serviceCategory"),
      AdminActivity.find().sort({ createdAt: -1 }).limit(12),
      Booking.find({
        status: { $in: ["completed", "amount_pending"] },
        $or: [
          { finalAmount: { $gt: 0 } },
          { quoteAmount: { $gt: 0 } },
          { price: { $gt: 0 } }
        ]
      }).select("finalAmount quoteAmount price paymentStatus status")
    ]);

    const paidPaymentRevenue = payments
      .filter((payment) => payment.status === "paid")
      .reduce((sum, payment) => sum + money(payment.amount), 0);
    const bookingRevenueFallback = amountBookings
      .filter((booking) => booking.status === "completed" || booking.paymentStatus === "paid")
      .reduce((sum, booking) => sum + bookingAmount(booking), 0);
    const totalRevenue = paidPaymentRevenue || bookingRevenueFallback;
    const pendingPaymentFallback = amountBookings
      .filter((booking) => booking.status === "amount_pending" || booking.paymentStatus === "pending")
      .reduce((sum, booking) => sum + bookingAmount(booking), 0);
    const pendingPaymentAmount = pendingPayments.reduce((sum, payment) => sum + money(payment.amount), 0) || pendingPaymentFallback;
    const totalCollection = payments.reduce((sum, payment) => sum + money(payment.amount), 0) || amountBookings.reduce((sum, booking) => sum + bookingAmount(booking), 0);
    const platformCommission = Math.round(totalRevenue * 0.12);
    const partnerEarnings = Math.max(totalRevenue - platformCommission, 0);
    const recentComplaints = [
      ...recentDisputes.map((entry) => ({
        id: id(entry._id),
        complaintId: entry.bookingCode || id(entry._id),
        userName: "",
        type: entry.reason || "review_dispute",
        status: entry.status || "",
        createdAt: iso(entry.createdAt),
        source: "review_dispute"
      })),
      ...recentTickets.map((entry) => ({
        id: id(entry._id),
        complaintId: entry.ticketCode || id(entry._id),
        userName: entry.userName || "",
        type: entry.category || "support",
        status: entry.status || "",
        createdAt: iso(entry.createdAt),
        source: "support_ticket"
      }))
    ].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 8);

    const payload = {
      generatedAt: new Date().toISOString(),
      analytics: {
        totalUsers,
        activeUsers,
        newUsersToday,
        totalPartners,
        activePartners,
        pendingPartnerApprovals,
        blockedPartners,
        totalBookings,
        completedBookings,
        cancelledBookings,
        pendingBookings,
        processingBookings,
        openComplaints: openReviewDisputes + openSupportTickets,
        resolvedComplaints: resolvedReviewDisputes + resolvedSupportTickets,
        totalRevenue,
        totalCollection,
        partnerEarnings,
        platformCommission,
        pendingPaymentAmount,
        totalTransactions: payments.length
      },
      bookingStatusBreakdown: [
        { status: "Completed", value: completedBookings },
        { status: "Pending", value: pendingBookings },
        { status: "Cancelled", value: cancelledBookings },
        { status: "Processing", value: processingBookings }
      ],
      recentBookings: recentBookings.map(bookingRow),
      recentComplaints,
      recentPayments: recentPayments.map(paymentRow),
      recentActivity: recentActivity.map(serializeAdminActivity),
      paymentsSummary: {
        totalCollection,
        partnerEarnings,
        platformCommission,
        pendingPaymentAmount
      }
    };
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
}

async function listAdminActivity(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 250);
    const query = {};
    const eventName = String(req.query.eventName || "").trim();
    const category = String(req.query.category || "").trim();
    const status = String(req.query.status || "").trim();
    const bookingId = String(req.query.bookingId || "").trim();
    const userId = objectId(req.query.userId);
    const partnerId = objectId(req.query.partnerId);
    const ticketId = String(req.query.ticketId || "").trim();

    if (eventName) query.eventName = eventName;
    if (category) query.category = category;
    if (status) query.status = status;
    if (bookingId) {
      const bookingObjectId = objectId(bookingId);
      query.$or = [
        ...(bookingObjectId ? [{ bookingId: bookingObjectId }] : []),
        { bookingCode: bookingId }
      ];
    }
    if (userId) query.userId = userId;
    if (partnerId) query.partnerId = partnerId;
    if (ticketId) query.ticketId = ticketId;

    const activity = await AdminActivity.find(query).sort({ createdAt: -1 }).limit(limit);
    return res.json({
      generatedAt: new Date().toISOString(),
      activity: activity.map(serializeAdminActivity)
    });
  } catch (error) {
    return next(error);
  }
}

async function listResourceRows(req, res, next) {
  try {
    const resource = String(req.params.resource || "").trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit || 100), 250);
    let rows = [];
    let metrics = {};

    if (resource === "users") {
      const users = await User.find().sort({ createdAt: -1 }).limit(limit);
      const userIds = users.map((user) => user._id);
      const [bookingCounts, disputeCounts, ticketCounts] = userIds.length ? await Promise.all([
        Booking.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }]),
        ReviewDispute.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }]),
        SupportTicket.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }])
      ]) : [[], [], []];
      const bookingCountMap = new Map(bookingCounts.map((entry) => [id(entry._id), entry.total]));
      const disputeCountMap = new Map(disputeCounts.map((entry) => [id(entry._id), entry.total]));
      const ticketCountMap = new Map(ticketCounts.map((entry) => [id(entry._id), entry.total]));
      rows = users.map((user) => {
        const userId = id(user._id);
        const addressList = savedAddresses(user);
        return {
          id: userId,
          fullName: user.name,
          mobileNumber: user.phone,
          email: user.email,
          profilePhoto: user.profilePhotoUrl || "",
          registrationDateTime: iso(user.createdAt),
          lastLoginTime: iso(user.lastLoginAt),
          accountStatus: normalizeAccountStatus(user.accountStatus),
          totalBookings: bookingCountMap.get(userId) || 0,
          totalComplaintsRaised: (disputeCountMap.get(userId) || 0) + (ticketCountMap.get(userId) || 0),
          currentLocation: coordinates(user.location),
          savedAddresses: addressList,
          deviceInformation: summarizeDeviceInfo(user.deviceInfo)
        };
      });
      metrics = {
        totalUsers: await User.countDocuments(),
        activeUsers: await User.countDocuments({ accountStatus: "active" })
      };
    } else if (resource === "partners") {
      const visiblePartnerFilter = { accountStatus: { $ne: "deleted" } };
      // Deleted records remain available to admins through the Deleted Partners metric.
      // The dashboard hides them from the default list and reveals them on demand.
      const partners = await Partner.find({}).sort({ createdAt: -1 }).limit(limit);
      const countMap = await bookingCountByPartner(partners.map((partner) => partner._id));
      const profileMap = await profileDocumentUrlMap(req, partners.map((partner) => partner._id));
      rows = partners.map((partner) => {
        const profilePhoto = partner.profilePhotoAssetId
          ? partnerAssetUrl(req, partner.profilePhotoAssetId)
          : profileMap.get(id(partner._id)) || "";
        return partnerRow(partner, countMap.get(id(partner._id)) || 0, profilePhoto);
      });
      metrics = {
        totalPartners: await Partner.countDocuments(visiblePartnerFilter),
        activePartners: await Partner.countDocuments({ accountStatus: "active", trustStatus: { $ne: "suspended" } }),
        pendingApproval: await Partner.countDocuments({ ...visiblePartnerFilter, kycStatus: { $in: ["missing", "submitted", "pending_review"] } }),
        blockedOrSuspended: await Partner.countDocuments({ ...visiblePartnerFilter, $or: [{ trustStatus: "suspended" }, { accountStatus: { $ne: "active" } }] }),
        deletedPartners: await Partner.countDocuments({ accountStatus: "deleted" }),
        totalBookings: await Booking.countDocuments({ partnerId: { $ne: null } })
      };
    } else if (resource === "devices") {
      const [users, partners] = await Promise.all([
        User.find({
          $or: [
            { fcmToken: { $nin: ["", null] } },
            { deviceTokens: { $elemMatch: { isActive: true } } }
          ]
        }).sort({ updatedAt: -1 }).limit(limit),
        Partner.find({
          $or: [
            { fcmToken: { $nin: ["", null] } },
            { deviceTokens: { $elemMatch: { isActive: true } } }
          ]
        }).sort({ updatedAt: -1 }).limit(limit)
      ]);
      rows = [...users.flatMap((user) => deviceRowsForOwner(user, "user")), ...partners.flatMap((partner) => deviceRowsForOwner(partner, "partner"))]
        .sort((left, right) => new Date(right.lastUpdatedAt || right.createdAt || 0).getTime() - new Date(left.lastUpdatedAt || left.createdAt || 0).getTime())
        .slice(0, limit);
      metrics = {
        totalDevices: rows.length,
        userDevices: rows.filter((row) => row.ownerType === "user").length,
        partnerDevices: rows.filter((row) => row.ownerType === "partner").length,
        activeDevices: rows.filter((row) => row.active).length
      };
    } else if (resource === "partner-approvals") {
      const pendingPartnerFilter = {
        kycStatus: { $in: ["missing", "submitted", "pending_review", "rejected"] },
        accountStatus: "active",
        trustStatus: { $ne: "suspended" }
      };
      const partners = await Partner.find(pendingPartnerFilter).sort({ createdAt: -1 }).limit(limit);
      const countMap = await bookingCountByPartner(partners.map((partner) => partner._id));
      const profileMap = await profileDocumentUrlMap(req, partners.map((partner) => partner._id));
      rows = partners.map((partner) => {
        const profilePhoto = partner.profilePhotoAssetId
          ? partnerAssetUrl(req, partner.profilePhotoAssetId)
          : profileMap.get(id(partner._id)) || "";
        return partnerRow(partner, countMap.get(id(partner._id)) || 0, profilePhoto);
      });
      metrics = {
        needsAction: await Partner.countDocuments(pendingPartnerFilter),
        pendingApproval: await Partner.countDocuments({ ...pendingPartnerFilter, kycStatus: { $in: ["missing", "submitted", "pending_review"] } }),
        submitted: await Partner.countDocuments({ kycStatus: "submitted" }),
        pendingReview: await Partner.countDocuments({ kycStatus: "pending_review" }),
        rejected: await Partner.countDocuments({ kycStatus: "rejected" }),
        verified: await Partner.countDocuments({ kycStatus: "verified" })
      };
    } else if (resource === "bookings" || resource === "quotes") {
      const bookings = await Booking.find().sort({ createdAt: -1 }).limit(limit);
      rows = bookings.map(bookingRow);
      const paidBookings = await Booking.find({ status: "completed" }).select("finalAmount quoteAmount price");
      const totalRevenue = paidBookings.reduce((sum, booking) => sum + bookingAmount(booking), 0);
      metrics = {
        totalBookings: await Booking.countDocuments(),
        completed: await Booking.countDocuments({ status: "completed" }),
        pending: await Booking.countDocuments({ status: { $in: ["pending", "sent_to_partner", "amount_pending"] } }),
        cancelled: await Booking.countDocuments({ status: { $in: ["cancelled", "canceled"] } }),
        totalRevenue,
        avgOrderValue: paidBookings.length ? Math.round(totalRevenue / paidBookings.length) : 0
      };
    } else if (resource === "payments") {
      const payments = await Payment.find().sort({ createdAt: -1 }).limit(limit).populate("partnerId", "name phone").populate("userId", "name phone").populate("bookingId", "bookingCode serviceName serviceCategory");
      rows = payments.map(paymentRow);
      const allPayments = await Payment.find().select("amount status");
      const paid = allPayments.filter((payment) => payment.status === "paid");
      const pending = allPayments.filter((payment) => ["created", "failed"].includes(payment.status));
      const totalRevenue = paid.reduce((sum, payment) => sum + money(payment.amount), 0);
      metrics = {
        totalPlatformRevenue: totalRevenue,
        totalPartnerEarnings: Math.round(totalRevenue * 0.88),
        totalCollection: allPayments.reduce((sum, payment) => sum + money(payment.amount), 0),
        pendingPayments: pending.reduce((sum, payment) => sum + money(payment.amount), 0),
        overduePayments: 0,
        totalTransactions: allPayments.length
      };
    } else if (resource === "services") {
      const services = await Service.find().sort({ createdAt: -1 }).limit(limit);
      rows = services.map((service) => ({
        id: id(service._id),
        name: service.name,
        category: service.serviceCategory || "",
        active: service.isActive !== false,
        status: service.status || "active",
        createdAt: iso(service.createdAt)
      }));
    } else if (resource === "complaints") {
      const disputes = await ReviewDispute.find().sort({ createdAt: -1 }).limit(limit);
      rows = disputes.map((dispute) => ({
        id: id(dispute._id),
        bookingCode: dispute.bookingCode || "",
        reason: dispute.reason,
        status: dispute.status,
        priority: "review",
        createdAt: iso(dispute.createdAt)
      }));
      metrics = {
        totalComplaints: await ReviewDispute.countDocuments(),
        open: await ReviewDispute.countDocuments({ status: "open" }),
        inProgress: await ReviewDispute.countDocuments({ status: "reviewing" }),
        resolved: await ReviewDispute.countDocuments({ status: { $in: ["accepted", "rejected"] } })
      };
    } else if (resource === "notifications") {
      const notifications = await AdminNotification.find().sort({ createdAt: -1 }).limit(limit);
      rows = notifications.map((notification) => ({
        id: id(notification._id),
        title: notification.title,
        sentTo: notification.targetType,
        recipients: notification.recipientCount,
        successCount: notification.successCount,
        failureCount: notification.failureCount,
        status: notification.status,
        sentBy: notification.sentByEmail || notification.sentBy,
        sentAt: iso(notification.sentAt || notification.scheduleAt || notification.createdAt),
        createdAt: iso(notification.createdAt)
      }));
      metrics = {
        totalNotifications: await AdminNotification.countDocuments(),
        sentToday: await AdminNotification.countDocuments({ sentAt: { $gte: startOfToday() } }),
        scheduled: await AdminNotification.countDocuments({ status: "scheduled" }),
        failed: await AdminNotification.countDocuments({ status: "failed" })
      };
    } else if (resource === "reports") {
      const [users, partners, bookings, completed, cancelled, disputes, tickets, payments] = await Promise.all([
        User.countDocuments(),
        Partner.countDocuments(),
        Booking.countDocuments(),
        Booking.countDocuments({ status: "completed" }),
        Booking.countDocuments({ status: { $in: ["cancelled", "canceled"] } }),
        ReviewDispute.countDocuments(),
        SupportTicket.countDocuments(),
        Payment.find().select("amount status")
      ]);
      const revenue = payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + money(payment.amount), 0);
      rows = [
        { id: "users", reportType: "Total Users", currentValue: users },
        { id: "partners", reportType: "Total Partners", currentValue: partners },
        { id: "bookings", reportType: "Total Bookings", currentValue: bookings },
        { id: "completedBookings", reportType: "Completed Bookings", currentValue: completed },
        { id: "cancelledBookings", reportType: "Cancelled Bookings", currentValue: cancelled },
        { id: "complaints", reportType: "Complaints", currentValue: disputes + tickets },
        { id: "revenue", reportType: "Paid Revenue", currentValue: revenue }
      ];
      metrics = { users, partners, bookings, completed, cancelled, complaints: disputes + tickets, revenue };
    } else if (["banners", "analytics", "audit-logs", "settings"].includes(resource)) {
      rows = [];
    } else {
      return res.status(404).json({ message: "Resource not found" });
    }

    return res.json({ resource, rows, metrics });
  } catch (error) {
    return next(error);
  }
}

async function performAdminAction(req, res, next) {
  try {
    const action = String(req.body?.action || "").trim();
    const targetId = String(req.body?.targetId || "").trim();
    if (!action || !targetId) {
      return res.status(400).json({ message: "action and targetId are required" });
    }

    if (action === "approve-technician") {
      const existingPartner = await Partner.findById(targetId).select("kycStatus accountStatus approvalVersion");
      if (!existingPartner) return res.status(404).json({ message: "Partner not found" });
      if (existingPartner.accountStatus === "deleted") {
        return res.status(409).json({ message: "Deleted partner cannot be approved" });
      }
      const isReapproval = existingPartner.kycStatus === "rejected"
        || existingPartner.accountStatus === "blocked"
        || existingPartner.accountStatus === "suspended";
      const now = new Date();
      const actor = req.auth?.email || req.auth?.uid || "admin";
      const partner = await Partner.findByIdAndUpdate(
        targetId,
        {
          $set: {
            isVerified: true,
            trustStatus: "trusted",
            kycStatus: "verified",
            accountStatus: "active",
            approvedAt: now,
            rejectedAt: null,
            rejectionReason: ""
          },
          $inc: { approvalVersion: 1 },
          $push: {
            verificationHistory: {
              action: isReapproval ? "reapproved" : "approved",
              at: now,
              by: actor,
              note: isReapproval ? "Partner approved again after admin review" : "Partner approved after verification"
            }
          }
        },
        { new: true }
      );
      await cache.del("admin:dashboard:v1");
      emitAdminEvent(isReapproval ? "partner:reapproved" : "partner:approved", {
        partnerId: String(partner._id),
        partnerCode: partner.partnerCode || "",
        partnerName: partner.name || "",
        partnerPhone: partner.phone || "",
        status: partner.kycStatus,
        by: actor,
        source: "admin_dashboard",
        approvalVersion: Number(partner.approvalVersion || 0),
        previousKycStatus: existingPartner.kycStatus
      });
      await reliableNotify({
        recipients: [partnerNotificationRecipient(partner)],
        title: isReapproval ? "Your account is approved again" : "You have been verified",
        body: isReapproval
          ? "Your ApnaServo partner account has been approved again. Keep your device online to receive bookings."
          : "Your ApnaServo partner profile is approved. Keep your device online to receive bookings.",
        category: "partner_approval",
        priority: "high",
        data: {
          type: isReapproval ? "partner:reapproved" : "partner:approved",
          targetApp: "partner",
          actionType: "OPEN_PARTNER_HOME",
          partnerId: partner._id,
          status: "verified",
          approvalVersion: Number(partner.approvalVersion || 0)
        },
        smsBody: isReapproval
          ? "ApnaServo: Your partner account is approved again. Keep your device online to receive bookings."
          : "ApnaServo: Your partner profile is verified. Keep your device online to receive bookings."
      });
      return res.json({ ok: true, action, targetId, status: partner.kycStatus, approval: "approved", reapproved: isReapproval, approvalVersion: Number(partner.approvalVersion || 0) });
    }

    if (action === "reject-technician" || action === "suspend-technician" || action === "block-technician") {
      const isSuspend = action === "suspend-technician" || action === "block-technician";
      const isBlock = action === "block-technician";
      const now = new Date();
      const actor = req.auth?.email || req.auth?.uid || "admin";
      const reason = String(req.body?.payload?.reason || "").trim();
      const historyAction = isBlock ? "blocked" : (isSuspend ? "suspended" : "rejected");
      const partner = await Partner.findByIdAndUpdate(
        targetId,
        {
          $set: {
            isOnline: false,
            isVerified: false,
            kycStatus: isSuspend ? "verified" : "rejected",
            trustStatus: isSuspend ? "suspended" : "review_required",
            ...(!isSuspend ? { rejectedAt: now, rejectionReason: reason } : {}),
            ...(isBlock ? { accountStatus: "blocked" } : {})
          },
          $push: {
            verificationHistory: {
              action: historyAction,
              at: now,
              by: actor,
              note: reason || (isSuspend ? "Partner access blocked by admin" : "Partner verification rejected by admin")
            }
          }
        },
        { new: true }
      );
      if (!partner) return res.status(404).json({ message: "Partner not found" });
      await cache.del("admin:dashboard:v1");
      emitAdminEvent(isBlock ? "partner:blocked" : (isSuspend ? "partner:suspended" : "partner:rejected"), {
        partnerId: String(partner._id),
        partnerCode: partner.partnerCode || "",
        partnerName: partner.name || "",
        partnerPhone: partner.phone || "",
        status: isSuspend ? partner.trustStatus : partner.kycStatus
      });
      await reliableNotify({
        recipients: [partnerNotificationRecipient(partner)],
        title: isSuspend ? "Partner account blocked" : "Verification not approved",
        body: isSuspend
          ? "Your ApnaServo partner account is blocked. Contact support for review."
          : "Your ApnaServo partner verification was not approved. Please contact support or update your details.",
        category: "partner_approval",
        priority: "high",
        data: {
          type: isBlock ? "partner:blocked" : (isSuspend ? "partner:suspended" : "partner:rejected"),
          targetApp: "partner",
          actionType: "OPEN_PARTNER_HOME",
          partnerId: partner._id,
          status: isSuspend ? "blocked" : "rejected"
        }
      });
      return res.json({ ok: true, action, targetId, status: isSuspend ? partner.accountStatus || partner.trustStatus : partner.kycStatus, approval: isSuspend ? "blocked" : "denied" });
    }

    if (action === "delete-partner") {
      const partner = await Partner.findById(targetId);
      if (!partner) return res.status(404).json({ message: "Partner not found" });
      const activeBookingCount = await Booking.countDocuments({
        partnerId: partner._id,
        status: { $nin: ["completed", "cancelled", "canceled", "rejected"] }
      });
      if (activeBookingCount > 0) {
        return res.status(409).json({ message: "This partner has active bookings. Reassign or complete those bookings before deleting." });
      }
      const now = new Date();
      for (const device of partner.deviceTokens || []) {
        device.isActive = false;
        device.lastUpdatedAt = now;
      }
      partner.fcmToken = "";
      partner.isOnline = false;
      partner.isVerified = false;
      partner.trustStatus = "suspended";
      partner.accountStatus = "deleted";
      partner.deletionRequestedAt = now;
      partner.deletionReason = "Deleted by admin dashboard";
      await partner.save();
      await cache.del("admin:dashboard:v1");
      emitAdminEvent("partner:deleted", {
        partnerId: String(partner._id),
        partnerCode: partner.partnerCode || "",
        partnerName: partner.name || "",
        partnerPhone: partner.phone || "",
        status: partner.accountStatus
      });
      return res.json({ ok: true, action, targetId, status: "deleted", deleted: true });
    }

    if (action === "delete-device") {
      const deleted = await deactivateAdminDevice(targetId);
      await cache.del("admin:dashboard:v1");
      emitAdminEvent("device:deleted", {
        ownerType: deleted.ownerType,
        ownerId: deleted.ownerId,
        ownerName: deleted.ownerName,
        deviceIdentifier: deleted.deviceIdentifier
      });
      return res.json({ ok: true, action, targetId, deleted: true });
    }

    return res.json({
      ok: true,
      action,
      targetId,
      message: "Action accepted for audit; no state transition was required."
    });
  } catch (error) {
    return next(error);
  }
}

const platformResetPlan = [
  ["Booking messages", BookingMessage],
  ["Customer no response reports", CustomerNoResponseReport],
  ["In-app notifications", InAppNotification],
  ["Location logs", LocationLog],
  ["Partner documents", PartnerDocument],
  ["Payments", Payment],
  ["Reviews", Review],
  ["Review disputes", ReviewDispute],
  ["Revisit requests", RevisitRequest],
  ["Support tickets", SupportTicket],
  ["Technician SOS", TechnicianSos],
  ["Bookings", Booking],
  ["Admin notifications", AdminNotification],
  ["Admin activity", AdminActivity],
  ["Partners", Partner],
  ["Users", User]
];

async function resetPlatformData(req, res, next) {
  try {
    const confirm = String(req.body?.confirm || req.headers["x-admin-reset-confirm"] || "").trim();
    if (confirm !== "DELETE_APNASERVO_DATA") {
      return res.status(400).json({ message: "Reset confirmation is required" });
    }

    const results = [];
    for (const [collection, model] of platformResetPlan) {
      const before = await model.countDocuments();
      const result = before > 0 ? await model.deleteMany({}) : { deletedCount: 0 };
      results.push({ collection, before, deleted: result.deletedCount || 0 });
    }

    emitAdminEvent("platform:reset", {
      by: req.auth?.email || req.auth?.uid || "admin",
      collections: results.length,
      deleted: results.reduce((sum, item) => sum + item.deleted, 0)
    });
    await cache.del("admin:dashboard:v1");
    return res.json({ ok: true, reset: results });
  } catch (error) {
    return next(error);
  }
}

async function findUserByPhoneOrId(userId, mobileNumber) {
  const directId = objectId(userId);
  if (directId) {
    const user = await User.findById(directId);
    if (user) return user;
  }
  const mobileDigits = digits(mobileNumber).slice(-10);
  if (!mobileDigits) return null;
  const users = await User.find().select("name phone email");
  return users.find((user) => digits(user.phone).slice(-10) === mobileDigits) || null;
}

async function userRestrictSetFromBookings({ bookingId, serviceType, bookingStatus }) {
  if (!bookingId && !serviceType && !bookingStatus) return null;
  const filter = {};
  const bookingObjectId = objectId(bookingId);
  if (bookingId) {
    filter.$or = [
      ...(bookingObjectId ? [{ _id: bookingObjectId }] : []),
      { bookingCode: regex(bookingId) }
    ];
  }
  if (serviceType) {
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { serviceCategory: regex(serviceType) },
          { serviceName: regex(serviceType) }
        ]
      }
    ];
  }
  if (bookingStatus) filter.status = bookingStatus;
  const bookings = await Booking.find(filter).select("userId");
  return new Set(bookings.map((booking) => id(booking.userId)).filter(Boolean));
}

async function userRestrictSetFromComplaints({ ticketId, complaintStatus }) {
  if (!ticketId && !complaintStatus) return null;
  const ticketObjectId = objectId(ticketId);
  const ticketFilter = {};
  if (ticketId) {
    ticketFilter.$or = [
      ...(ticketObjectId ? [{ _id: ticketObjectId }] : []),
      { ticketCode: regex(ticketId) }
    ];
  }
  if (complaintStatus) ticketFilter.status = complaintStatus;
  const disputeFilter = {};
  if (complaintStatus) disputeFilter.status = complaintStatus;
  const [tickets, disputes] = await Promise.all([
    SupportTicket.find(ticketFilter).select("userId"),
    ReviewDispute.find(disputeFilter).select("userId")
  ]);
  return new Set([
    ...tickets.map((ticket) => id(ticket.userId)),
    ...disputes.map((dispute) => id(dispute.userId))
  ].filter(Boolean));
}

async function usersControlCenter(req, res, next) {
  try {
    const query = {
      search: String(req.query.search || "").trim(),
      name: String(req.query.name || "").trim(),
      mobile: String(req.query.mobile || "").trim(),
      bookingId: String(req.query.bookingId || "").trim(),
      ticketId: String(req.query.ticketId || "").trim(),
      serviceType: String(req.query.serviceType || "").trim(),
      bookingStatus: String(req.query.bookingStatus || "").trim(),
      complaintStatus: String(req.query.complaintStatus || "").trim(),
      registrationDate: String(req.query.registrationDate || "").trim()
    };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [
      totalUsers,
      activeUsers,
      newUsersToday,
      totalBookings,
      completedBookings,
      cancelledBookings,
      openReviewDisputes,
      resolvedReviewDisputes,
      openSupportTickets,
      resolvedSupportTickets,
      allUsers,
      allTickets
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ accountStatus: "active" }),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      Booking.countDocuments(),
      Booking.countDocuments({ status: "completed" }),
      Booking.countDocuments({ status: { $in: ["cancelled", "canceled"] } }),
      ReviewDispute.countDocuments({ status: { $in: ["open", "reviewing"] } }),
      ReviewDispute.countDocuments({ status: { $in: ["accepted", "rejected"] } }),
      SupportTicket.countDocuments({ status: { $in: ["open", "assigned", "in_progress", "waiting_on_customer", "reopened", "escalated"] } }),
      SupportTicket.countDocuments({ status: { $in: ["resolved", "closed"] } }),
      User.find().sort({ createdAt: -1 }),
      SupportTicket.find().sort({ lastUpdatedAt: -1, createdAt: -1 })
    ]);

    let bookingSearchSet = new Set();
    let ticketSearchSet = new Set();
    if (query.search) {
      const searchRegex = regex(query.search);
      const searchObjectId = objectId(query.search);
      const [bookings, tickets] = await Promise.all([
        Booking.find({
          $or: [
            ...(searchObjectId ? [{ _id: searchObjectId }] : []),
            { bookingCode: searchRegex },
            { serviceName: searchRegex },
            { serviceCategory: searchRegex }
          ]
        }).select("userId"),
        SupportTicket.find({
          $or: [
            ...(searchObjectId ? [{ _id: searchObjectId }] : []),
            { ticketCode: searchRegex },
            { bookingCode: searchRegex }
          ]
        }).select("userId")
      ]);
      bookingSearchSet = new Set(bookings.map((booking) => id(booking.userId)).filter(Boolean));
      ticketSearchSet = new Set(tickets.map((ticket) => id(ticket.userId)).filter(Boolean));
    }

    const [bookingRestrictSet, complaintRestrictSet] = await Promise.all([
      userRestrictSetFromBookings(query),
      userRestrictSetFromComplaints(query)
    ]);

    const registrationDate = query.registrationDate ? new Date(query.registrationDate) : null;
    const registrationEnd = registrationDate && !Number.isNaN(registrationDate.getTime())
      ? new Date(registrationDate.getTime() + 24 * 60 * 60 * 1000)
      : null;

    let users = allUsers.filter((user) => {
      const userId = id(user._id);
      if (query.name && !includesText(user.name, query.name)) return false;
      if (query.mobile && !digits(user.phone).includes(digits(query.mobile))) return false;
      if (registrationDate && registrationEnd) {
        const created = new Date(user.createdAt);
        if (created < registrationDate || created >= registrationEnd) return false;
      }
      if (bookingRestrictSet && !bookingRestrictSet.has(userId)) return false;
      if (complaintRestrictSet && !complaintRestrictSet.has(userId)) return false;
      if (query.search) {
        const textMatch = includesText(user.name, query.search)
          || includesText(user.phone, query.search)
          || includesText(user.email, query.search)
          || includesText(user.city, query.search);
        if (!textMatch && !bookingSearchSet.has(userId) && !ticketSearchSet.has(userId)) return false;
      }
      return true;
    });

    const userIds = users.map((user) => user._id);
    const [bookingCounts, disputeCounts, ticketCounts] = userIds.length ? await Promise.all([
      Booking.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }]),
      ReviewDispute.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }]),
      SupportTicket.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: "$userId", total: { $sum: 1 } } }])
    ]) : [[], [], []];
    const bookingCountMap = new Map(bookingCounts.map((entry) => [id(entry._id), entry.total]));
    const disputeCountMap = new Map(disputeCounts.map((entry) => [id(entry._id), entry.total]));
    const ticketCountMap = new Map(ticketCounts.map((entry) => [id(entry._id), entry.total]));

    let tickets = allTickets;
    if (query.search || query.mobile || query.name || query.ticketId || query.complaintStatus || query.bookingId) {
      tickets = allTickets.filter((ticket) => {
        if (query.ticketId && !includesText(ticket.ticketCode, query.ticketId) && id(ticket._id) !== query.ticketId) return false;
        if (query.bookingId && !includesText(ticket.bookingCode, query.bookingId) && id(ticket.bookingId) !== query.bookingId) return false;
        if (query.complaintStatus && ticket.status !== query.complaintStatus) return false;
        if (query.mobile && !digits(ticket.mobileNumber).includes(digits(query.mobile))) return false;
        if (query.name && !includesText(ticket.userName, query.name)) return false;
        if (query.search) {
          return includesText(ticket.ticketCode, query.search)
            || includesText(ticket.userName, query.search)
            || includesText(ticket.mobileNumber, query.search)
            || includesText(ticket.bookingCode, query.search)
            || includesText(ticket.category, query.search)
            || includesText(ticket.complaint, query.search);
        }
        return true;
      });
    }

    return res.json({
      analytics: {
        totalUsers,
        activeUsers,
        newUsersToday,
        totalBookings,
        completedBookings,
        cancelledBookings,
        openComplaints: openReviewDisputes + openSupportTickets,
        resolvedComplaints: resolvedReviewDisputes + resolvedSupportTickets
      },
      users: users.map((user) => {
        const userId = id(user._id);
        const addressList = savedAddresses(user);
        return {
          id: userId,
          fullName: user.name || "",
          mobileNumber: user.phone || "",
          email: user.email || "",
          profilePhoto: user.profilePhotoUrl || "",
          registrationDateTime: iso(user.createdAt),
          lastLoginTime: iso(user.lastLoginAt),
          accountStatus: normalizeAccountStatus(user.accountStatus),
          rawAccountStatus: user.accountStatus || "active",
          totalBookings: bookingCountMap.get(userId) || 0,
          totalComplaintsRaised: (disputeCountMap.get(userId) || 0) + (ticketCountMap.get(userId) || 0),
          currentLocation: coordinates(user.location),
          savedAddresses: addressList,
          savedAddressText: addressList.map((entry) => entry.address).filter(Boolean).join(" | "),
          deviceInformation: summarizeDeviceInfo(user.deviceInfo),
          rawDeviceInformation: user.deviceInfo || {}
        };
      }),
      supportTickets: tickets.map(serializeSupportTicket)
    });
  } catch (error) {
    return next(error);
  }
}

async function userProfile(req, res, next) {
  try {
    const userObjectId = objectId(req.params.userId);
    if (!userObjectId) return res.status(400).json({ message: "Invalid user id" });
    const user = await User.findById(userObjectId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const bookings = await Booking.find({ userId: user._id }).sort({ createdAt: -1 });
    const bookingIds = bookings.map((booking) => booking._id);
    const [payments, disputes, noResponseReports, revisitRequests, sosReports, messages, ticketCandidates] = await Promise.all([
      Payment.find({ userId: user._id }).sort({ createdAt: -1 }),
      ReviewDispute.find({ userId: user._id }).sort({ createdAt: -1 }),
      CustomerNoResponseReport.find({ userId: user._id }).sort({ createdAt: -1 }),
      RevisitRequest.find({ userId: user._id }).sort({ createdAt: -1 }),
      TechnicianSos.find({ userId: user._id }).sort({ createdAt: -1 }),
      bookingIds.length ? BookingMessage.find({ bookingId: { $in: bookingIds } }).sort({ createdAt: 1 }).limit(500) : [],
      SupportTicket.find({ $or: [{ userId: user._id }, { userId: null }] }).sort({ createdAt: -1 }).limit(1000)
    ]);

    const userPhone = digits(user.phone).slice(-10);
    const tickets = ticketCandidates.filter((ticket) => id(ticket.userId) === id(user._id) || (userPhone && digits(ticket.mobileNumber).slice(-10) === userPhone));
    const paymentsByBooking = new Map();
    for (const payment of payments) {
      const key = id(payment.bookingId);
      paymentsByBooking.set(key, [...(paymentsByBooking.get(key) || []), payment]);
    }
    const messagesByBooking = new Map();
    for (const message of messages) {
      const key = id(message.bookingId);
      messagesByBooking.set(key, [...(messagesByBooking.get(key) || []), message]);
    }

    const rawProfile = user.toObject({ getters: true });
    delete rawProfile.fcmToken;

    return res.json({
      user: {
        id: id(user._id),
        firebaseUid: user.firebaseUid || "",
        fullName: user.name || "",
        mobileNumber: user.phone || "",
        email: user.email || "",
        profilePhoto: user.profilePhotoUrl || "",
        address: user.address || "",
        savedAddresses: savedAddresses(user),
        city: user.city || "",
        currentLocation: coordinates(user.location),
        registrationDateTime: iso(user.createdAt),
        lastLoginTime: iso(user.lastLoginAt),
        phoneVerified: Boolean(user.phoneVerified),
        phoneVerifiedAt: iso(user.phoneVerifiedAt),
        bookingRiskStatus: user.bookingRiskStatus || "",
        fakeBookingWarningCount: user.fakeBookingWarningCount || 0,
        accountStatus: normalizeAccountStatus(user.accountStatus),
        rawAccountStatus: user.accountStatus || "active",
        deviceInformation: summarizeDeviceInfo(user.deviceInfo),
        rawDeviceInformation: user.deviceInfo || {},
        registrationHistory: (user.registrationHistory || []).map((entry) => ({
          source: entry.source || "",
          provider: entry.provider || "",
          registeredAt: iso(entry.registeredAt),
          ip: entry.ip || "",
          userAgent: entry.userAgent || ""
        })),
        loginHistory: (user.loginHistory || []).map((entry) => ({
          loggedInAt: iso(entry.loggedInAt),
          ip: entry.ip || "",
          userAgent: entry.userAgent || "",
          deviceInfo: entry.deviceInfo || {}
        })),
        adminNotes: (user.adminNotes || []).map((entry) => ({
          id: id(entry._id),
          note: entry.note || "",
          addedBy: entry.addedBy || "",
          addedAt: iso(entry.addedAt)
        })),
        rawProfile
      },
      bookingHistory: bookings.map((booking) => serializeBookingHistory(
        booking,
        paymentsByBooking.get(id(booking._id)) || [],
        messagesByBooking.get(id(booking._id)) || []
      )),
      complaintHistory: [
        ...disputes.map((entry) => ({ type: "review_dispute", ...serializeDispute(entry) })),
        ...noResponseReports.map((entry) => ({
          type: "customer_no_response",
          id: id(entry._id),
          bookingId: id(entry.bookingId),
          bookingCode: entry.bookingCode || "",
          reason: entry.reason || "",
          status: entry.status || "",
          createdAt: iso(entry.createdAt),
          reportedAt: iso(entry.reportedAt)
        })),
        ...revisitRequests.map((entry) => ({
          type: "revisit_request",
          id: id(entry._id),
          bookingId: id(entry.bookingId),
          bookingCode: entry.bookingCode || "",
          reason: entry.reason || "",
          message: entry.message || "",
          status: entry.status || "",
          requestedAt: iso(entry.requestedAt),
          createdAt: iso(entry.createdAt)
        })),
        ...sosReports.map((entry) => ({
          type: "technician_sos",
          id: id(entry._id),
          bookingId: id(entry.bookingId),
          bookingCode: entry.bookingCode || "",
          reason: entry.reason || "",
          note: entry.note || "",
          status: entry.status || "",
          createdAt: iso(entry.createdAt)
        }))
      ].sort((a, b) => new Date(b.createdAt || b.requestedAt || b.reportedAt || 0).getTime() - new Date(a.createdAt || a.requestedAt || a.reportedAt || 0).getTime()),
      supportTicketHistory: tickets.map(serializeSupportTicket),
      paymentHistory: payments.map(serializePayment)
    });
  } catch (error) {
    return next(error);
  }
}

async function updateUserAdminState(req, res, next) {
  try {
    const userObjectId = objectId(req.params.userId);
    if (!userObjectId) return res.status(400).json({ message: "Invalid user id" });
    const allowedStatuses = new Set(["active", "suspended", "blocked"]);
    const update = {};
    const status = String(req.body?.accountStatus || "").trim().toLowerCase();
    if (status) {
      if (!allowedStatuses.has(status)) return res.status(400).json({ message: "Invalid account status" });
      update.accountStatus = status;
    }

    const note = String(req.body?.adminNote || "").trim().slice(0, 2000);
    const operations = {};
    if (Object.keys(update).length) operations.$set = update;
    if (note) {
      operations.$push = {
        adminNotes: {
          note,
          addedBy: req.auth?.email || "admin",
          addedAt: new Date()
        }
      };
    }
    if (!Object.keys(operations).length) return res.status(400).json({ message: "No user changes supplied" });
    const user = await User.findByIdAndUpdate(userObjectId, operations, { new: true });
    if (!user) return res.status(404).json({ message: "User not found" });
    emitAdminEvent("user:updated", { userId: id(user._id), accountStatus: user.accountStatus });
    return res.json({ ok: true, userId: id(user._id), accountStatus: user.accountStatus });
  } catch (error) {
    return next(error);
  }
}

function partnerDocumentUrl(req, document) {
  if (document.partnerUploadAssetId) {
    return partnerAssetUrl(req, document.partnerUploadAssetId);
  }
  return document.url || "";
}

function latestPartnerProfileDocumentUrl(req, documents = []) {
  const profileTypes = new Set(["profile_photo", "selfie_photo", "face_photo", "selfie_verification"]);
  const document = documents.find((entry) => profileTypes.has(String(entry.documentType || "").toLowerCase()));
  return document ? partnerDocumentUrl(req, document) : "";
}

async function profileDocumentUrlMap(req, partnerIds = []) {
  if (!partnerIds.length) return new Map();
  const documents = await PartnerDocument.find({
    partnerId: { $in: partnerIds },
    documentType: { $in: ["profile_photo", "selfie_photo", "face_photo", "selfie_verification"] }
  }).sort({ createdAt: -1 });
  const urls = new Map();
  for (const document of documents) {
    const partnerKey = id(document.partnerId);
    if (!urls.has(partnerKey)) {
      urls.set(partnerKey, partnerDocumentUrl(req, document));
    }
  }
  return urls;
}

function serializePartnerDocument(document, req) {
  return {
    id: id(document._id),
    documentType: document.documentType || "",
    originalName: document.originalName || "",
    mimeType: document.mimeType || "",
    sizeBytes: Number(document.sizeBytes || 0),
    url: partnerDocumentUrl(req, document),
    storageProvider: document.storageProvider || "",
    partnerUploadAssetId: id(document.partnerUploadAssetId),
    validationStatus: document.validationStatus || "review",
    validationScore: Number(document.validationScore || 0),
    validationReasons: document.validationReasons || [],
    ocrStatus: document.ocrStatus || "",
    aadhaarLast4: document.aadhaarLast4 || "",
    uploadedAt: iso(document.createdAt),
    updatedAt: iso(document.updatedAt)
  };
}

async function partnerUploadAsset(req, res, next) {
  try {
    const assetObjectId = objectId(req.params.assetId);
    if (!assetObjectId || !verifyPartnerAssetToken(assetObjectId, req.query.token)) {
      return res.status(404).json({ message: "Asset not found" });
    }
    const record = await PartnerUploadAsset.findById(assetObjectId).lean();
    if (!record) return res.status(404).json({ message: "Asset not found" });
    const buffer = Buffer.from(record.dataBase64 || "", "base64");
    res.set("Content-Type", record.mimeType || "image/jpeg");
    res.set("Content-Length", String(buffer.length));
    res.set("Cache-Control", "private, max-age=2592000, immutable");
    res.set("Content-Disposition", `inline; filename="${(record.originalName || "partner-upload.jpg").replace(/"/g, "")}"`);
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
}

async function partnerProfile(req, res, next) {
  try {
    const partnerObjectId = objectId(req.params.partnerId);
    if (!partnerObjectId) return res.status(400).json({ message: "Invalid partner id" });
    const partner = await Partner.findById(partnerObjectId);
    if (!partner) return res.status(404).json({ message: "Partner not found" });
    const [documents, bookings, tickets] = await Promise.all([
      PartnerDocument.find({ partnerId: partner._id }).sort({ documentType: 1, createdAt: -1 }),
      Booking.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(100),
      SupportTicket.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(100)
    ]);
    const approved = partner.isVerified === true && partner.kycStatus === "verified" && partner.trustStatus === "trusted";
    const blocked = partner.accountStatus === "blocked" || partner.accountStatus === "suspended" || partner.trustStatus === "suspended";
    const rawProfile = partner.toObject({ getters: true });
    const profilePhoto = partner.profilePhotoAssetId
      ? partnerAssetUrl(req, partner.profilePhotoAssetId)
      : (partner.photoUrl || partner.selfieUrl || latestPartnerProfileDocumentUrl(req, documents));
    delete rawProfile.fcmToken;
    delete rawProfile.deviceTokens;
    const activityHistory = [
      ...(partner.verificationHistory || []).map((entry, index) => ({
        id: `${id(partner._id)}:verification:${index}`,
        type: "verification",
        title: `Verification ${String(entry.action || "updated").replace(/_/g, " ")}`,
        description: [entry.note || "", entry.by ? `By ${entry.by}` : ""].filter(Boolean).join(" - "),
        createdAt: iso(entry.at)
      })),
      ...documents.map((document) => ({
        id: `${id(document._id)}:document`,
        type: "document",
        title: `${String(document.documentType || "Document").replace(/_/g, " ")} uploaded`,
        description: `Validation status: ${document.validationStatus || "review"}`,
        createdAt: iso(document.createdAt)
      })),
      ...bookings.map((booking) => ({
        id: `${id(booking._id)}:booking`,
        type: "booking",
        title: `Booking ${booking.bookingCode || id(booking._id)}`,
        description: `${booking.serviceName || booking.serviceCategory || "Service"} - ${booking.status || "pending"}`,
        createdAt: iso(booking.updatedAt || booking.createdAt)
      })),
      ...tickets.map((ticket) => ({
        id: `${id(ticket._id)}:support`,
        type: "support",
        title: ticket.subject || ticket.title || ticket.category || "Support ticket",
        description: `Ticket ${ticket.ticketCode || id(ticket._id)} - ${ticket.status || "open"}`,
        createdAt: iso(ticket.updatedAt || ticket.createdAt)
      })),
      {
        id: `${id(partner._id)}:registered`,
        type: "registration",
        title: "Partner registered",
        description: `${partner.name || "Partner"} submitted the registration profile.`,
        createdAt: iso(partner.createdAt)
      }
    ].filter((entry) => entry.createdAt).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return res.json({
      partner: {
        id: id(partner._id),
        firebaseUid: partner.firebaseUid || "",
        partnerCode: partner.partnerCode || "",
        profilePhoto,
        photoUrl: partner.photoUrl || "",
        selfieUrl: partner.selfieUrl || "",
        fullName: partner.name || "",
        mobileNumber: partner.phone || "",
        email: partner.email || "",
        dateOfBirth: partner.dateOfBirth || "",
        gender: partner.gender || "",
        completeResidentialAddress: partner.residentialAddress || "",
        city: partner.city || "",
        state: partner.state || "",
        pinCode: partner.pinCode || "",
        emergencyContactNumber: partner.emergencyContactNumber || "",
        professionServiceCategory: partner.serviceCategory || [],
        yearsOfExperience: Number(partner.yearsOfExperience || 0),
        workingAreas: partner.workingAreas || [],
        serviceArea: partner.serviceArea || "",
        serviceRadiusKm: Number(partner.serviceRadiusKm || 0),
        languagesKnown: partner.languagesKnown || [],
        registrationDate: iso(partner.createdAt),
        currentVerificationStatus: blocked ? "Blocked" : (approved ? "Approved" : (partner.kycStatus === "rejected" ? "Rejected" : "Under Verification")),
        approvalVersion: Number(partner.approvalVersion || 0),
        approvedAt: iso(partner.approvedAt),
        rejectedAt: iso(partner.rejectedAt),
        rejectionReason: partner.rejectionReason || "",
        verificationHistory: partner.verificationHistory || [],
        isVerified: Boolean(partner.isVerified),
        kycStatus: partner.kycStatus || "",
        trustStatus: partner.trustStatus || "",
        accountStatus: partner.accountStatus || "active",
        online: Boolean(partner.isOnline),
        aadhaarStatus: partner.aadhaarStatus || "",
        idProofStatus: partner.idProofStatus || "",
        skillCertificateStatus: partner.skillCertificateStatus || "",
        rawProfile
      },
      documents: documents.map((document) => serializePartnerDocument(document, req)),
      bookingHistory: bookings.map(bookingRow),
      supportTickets: tickets.map(serializeSupportTicket),
      activityHistory
    });
  } catch (error) {
    return next(error);
  }
}

async function updatePartnerDocument(req, res, next) {
  try {
    const partnerObjectId = objectId(req.params.partnerId);
    const documentObjectId = objectId(req.params.documentId);
    if (!partnerObjectId || !documentObjectId) return res.status(400).json({ message: "Invalid partner or document id" });
    const status = String(req.body?.validationStatus || "").trim().toLowerCase();
    if (!["accepted", "rejected", "review"].includes(status)) {
      return res.status(400).json({ message: "Invalid validation status" });
    }
    const document = await PartnerDocument.findOneAndUpdate(
      { _id: documentObjectId, partnerId: partnerObjectId },
      { $set: { validationStatus: status } },
      { new: true }
    );
    if (!document) return res.status(404).json({ message: "Document not found" });
    emitAdminEvent("partner:document_updated", {
      partnerId: String(partnerObjectId),
      documentId: String(document._id),
      documentType: document.documentType,
      status
    });
    return res.json({ ok: true, document: serializePartnerDocument(document, req) });
  } catch (error) {
    return next(error);
  }
}

async function bookingTimelineDetails(req, res, next) {
  try {
    const raw = String(req.params.bookingId || "").trim();
    const bookingObjectId = objectId(raw);
    const booking = await Booking.findOne({
      $or: [
        ...(bookingObjectId ? [{ _id: bookingObjectId }] : []),
        { bookingCode: raw }
      ]
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const [payments, messages] = await Promise.all([
      Payment.find({ bookingId: booking._id }).sort({ createdAt: 1 }),
      BookingMessage.find({ bookingId: booking._id }).sort({ createdAt: 1 }).limit(200)
    ]);
    return res.json({ booking: serializeBookingHistory(booking, payments, messages) });
  } catch (error) {
    return next(error);
  }
}

async function listSupportTickets(req, res, next) {
  try {
    const status = String(req.query.status || "").trim();
    const filter = status ? { status } : {};
    const tickets = await SupportTicket.find(filter).sort({ lastUpdatedAt: -1, createdAt: -1 });
    return res.json({ tickets: tickets.map(serializeSupportTicket) });
  } catch (error) {
    return next(error);
  }
}

async function createSupportTicket(req, res, next) {
  try {
    const body = req.body || {};
    const user = await findUserByPhoneOrId(body.userId, body.mobileNumber || body.phone);
    const now = new Date();
    const ticket = await SupportTicket.create({
      ticketCode: String(body.ticketId || body.ticketCode || ticketCode()).trim(),
      userId: user?._id || null,
      bookingId: objectId(body.bookingId),
      bookingCode: String(body.bookingCode || "").trim(),
      userName: String(body.userName || user?.name || "").trim(),
      mobileNumber: String(body.mobileNumber || body.phone || user?.phone || "").trim(),
      email: String(body.email || user?.email || "").trim(),
      category: String(body.category || body.ticketCategory || "general").trim(),
      priority: String(body.priority || "normal").trim().toLowerCase(),
      status: String(body.status || "open").trim().toLowerCase(),
      source: String(body.source || "ai_support").trim(),
      complaint: String(body.complaint || body.message || "").trim(),
      aiSummary: String(body.aiSummary || body.summary || "").trim(),
      conversation: Array.isArray(body.conversation) ? body.conversation : [],
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      timeline: [{ event: "ticket_created", by: body.source || "ai_support", note: "Support ticket generated", at: now }],
      lastUpdatedAt: now
    });
    emitAdminEvent("support:ticket_created", {
      ticketId: ticket.ticketCode,
      userId: id(ticket.userId),
      userName: ticket.userName,
      priority: ticket.priority,
      status: ticket.status
    });
    return res.status(201).json({ ticket: serializeSupportTicket(ticket) });
  } catch (error) {
    return next(error);
  }
}

async function findTicket(raw) {
  const ticketObjectId = objectId(raw);
  return SupportTicket.findOne({
    $or: [
      ...(ticketObjectId ? [{ _id: ticketObjectId }] : []),
      { ticketCode: String(raw || "").trim() }
    ]
  });
}

async function supportTicketDetails(req, res, next) {
  try {
    const ticket = await findTicket(req.params.ticketId);
    if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
    const booking = ticket.bookingId
      ? await Booking.findById(ticket.bookingId).select("serviceCategory serviceName city address partnerSnapshot bookingCode")
      : null;
    return res.json({
      ticket: {
        ...serializeSupportTicket(ticket),
        serviceCategory: booking?.serviceCategory || "",
        serviceName: booking?.serviceName || "",
        area: booking?.city || "",
        customerAddress: booking?.address || "",
        assignedPartnerName: booking?.partnerSnapshot?.name || "",
        bookingCode: ticket.bookingCode || booking?.bookingCode || ""
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function updateSupportTicket(req, res, next) {
  try {
    const ticket = await findTicket(req.params.ticketId);
    if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
    const body = req.body || {};
    const now = new Date();
    const actor = req.auth?.email || "admin";
    const action = String(body.action || "update").trim();

    if (body.assignedTo !== undefined) {
      ticket.assignedTo = String(body.assignedTo || "").trim();
      if (ticket.assignedTo && ticket.status === "open") ticket.status = "assigned";
      ticket.timeline.push({ event: "assigned", by: actor, note: ticket.assignedTo, at: now });
    }
    if (body.status) {
      ticket.status = String(body.status).trim().toLowerCase();
      ticket.timeline.push({ event: "status_changed", by: actor, note: ticket.status, at: now });
    }
    if (body.priority) {
      const priority = String(body.priority).trim().toLowerCase();
      ticket.priority = priority === "critical" ? "urgent" : priority;
      ticket.timeline.push({ event: "priority_changed", by: actor, note: ticket.priority, at: now });
    }
    if (action === "mark_resolved") {
      ticket.status = "resolved";
      ticket.resolvedAt = now;
      ticket.timeline.push({ event: "resolved", by: actor, note: body.resolutionNotes || "", at: now });
    }
    if (action === "reopen") {
      ticket.status = "reopened";
      ticket.reopenedAt = now;
      ticket.timeline.push({ event: "reopened", by: actor, note: body.internalNote || "", at: now });
    }
    if (action === "escalate") {
      ticket.status = "escalated";
      ticket.escalatedTo = String(body.escalatedTo || body.assignedTo || "senior_support").trim();
      ticket.timeline.push({ event: "escalated", by: actor, note: ticket.escalatedTo, at: now });
    }
    const internalNote = String(body.internalNote || "").trim().slice(0, 2000);
    if (internalNote) {
      ticket.internalNotes.push({ note: internalNote, addedBy: actor, addedAt: now });
      ticket.timeline.push({ event: "internal_note_added", by: actor, note: internalNote.slice(0, 180), at: now });
    }
    const adminReply = String(body.adminReply || "").trim().slice(0, 3000);
    if (adminReply) {
      const reply = { senderRole: "admin", senderName: actor, message: adminReply, attachments: [], createdAt: now };
      ticket.adminReplies.push(reply);
      ticket.conversation.push(reply);
      ticket.timeline.push({ event: "admin_replied", by: actor, note: adminReply.slice(0, 180), at: now });
    }
    if (body.resolutionNotes !== undefined) {
      ticket.resolutionNotes = String(body.resolutionNotes || "").trim().slice(0, 3000);
    }
    ticket.lastUpdatedAt = now;
    await ticket.save();
    emitAdminEvent("support:ticket_updated", {
      ticketId: ticket.ticketCode,
      status: ticket.status,
      assignedTo: ticket.assignedTo
    });
    return res.json({ ticket: serializeSupportTicket(ticket) });
  } catch (error) {
    return next(error);
  }
}

async function listReviewDisputes(req, res, next) {
  try {
    const status = String(req.query.status || "open").toLowerCase();
    const query = status === "all" ? {} : { status };
    const disputes = await ReviewDispute.find(query).sort({ createdAt: -1 }).limit(100);
    return res.json({ disputes: disputes.map(serializeDispute) });
  } catch (error) {
    return next(error);
  }
}

async function resolveReviewDispute(req, res, next) {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["reviewing", "accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be reviewing, accept, or reject" });
    }

    const dispute = await ReviewDispute.findById(req.params.disputeId);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }
    const review = await Review.findById(dispute.reviewId);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    if (action === "reviewing") {
      dispute.status = "reviewing";
    } else if (action === "accept") {
      dispute.status = "accepted";
      dispute.resolvedAt = new Date();
      review.status = "hidden";
      review.disputeStatus = "resolved";
      review.resolvedAt = dispute.resolvedAt;
    } else {
      dispute.status = "rejected";
      dispute.resolvedAt = new Date();
      review.status = "published";
      review.disputeStatus = "resolved";
      review.resolvedAt = dispute.resolvedAt;
    }

    const note = String(req.body?.resolutionNote || "").slice(0, 1000);
    dispute.resolutionNote = note;
    dispute.resolvedBy = req.auth.email || req.auth.uid || "admin";
    review.adminResolution = note;
    await Promise.all([dispute.save(), review.save()]);
    emitAdminEvent("complaint:updated", {
      disputeId: id(dispute._id),
      bookingId: id(dispute.bookingId),
      bookingCode: dispute.bookingCode || "",
      userId: id(dispute.userId),
      status: dispute.status
    });

    await Booking.findByIdAndUpdate(review.bookingId, {
      $set: {
        "reviewSnapshot.status": review.status,
        "reviewSnapshot.disputeStatus": review.disputeStatus
      }
    });
    const ratingSummary = await recomputePartnerRating(review.partnerId);

    return res.json({
      dispute: serializeDispute(dispute),
      review: {
        id: String(review._id),
        status: review.status,
        disputeStatus: review.disputeStatus
      },
      partnerRating: ratingSummary
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  dashboard,
  listAdminActivity,
  listResourceRows,
  performAdminAction,
  smartAssignmentDashboard,
  smartAssignBooking,
  smartBulkAssignPending,
  resetPlatformData,
  usersControlCenter,
  userProfile,
  updateUserAdminState,
  partnerUploadAsset,
  partnerProfile,
  updatePartnerDocument,
  bookingTimelineDetails,
  listSupportTickets,
  createSupportTicket,
  supportTicketDetails,
  updateSupportTicket,
  listReviewDisputes,
  resolveReviewDispute
};
