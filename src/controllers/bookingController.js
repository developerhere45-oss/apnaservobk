const mongoose = require("mongoose");
const crypto = require("crypto");
const { z } = require("zod");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking, BOOKING_STATUSES } = require("../models/Booking");
const CallLog = require("../models/CallLog");
const LocationLog = require("../models/LocationLog");
const CommissionLedger = require("../models/CommissionLedger");
const CustomerNoResponseReport = require("../models/CustomerNoResponseReport");
const TechnicianSos = require("../models/TechnicianSos");
const JobProofPhoto = require("../models/JobProofPhoto");
const RevisitRequest = require("../models/RevisitRequest");
const { cloudinary } = require("../config/cloudinary");
const { normalizeServiceCategory, serviceCategoryVariants, serviceLabel, companySingleServiceCategory } = require("../utils/serviceCategory");
const { validatePartnerLocation, partnerLocationUpdate } = require("../utils/locationValidation");
const { recordFraudSignal } = require("../utils/fraudDetection");
const {
  normalizeBookingStatusInput,
  pendingAssignmentStatuses,
  transitionDecision
} = require("../utils/bookingLifecycle");
const findNearbyPartners = require("../utils/findNearbyPartners");
const { reliableNotify } = require("../utils/reliableNotify");
const { activeDeviceTokens } = require("../utils/notificationTokens");
const {
  emitNewBookingToPartners,
  emitBookingAccepted,
  emitBookingRejected,
  emitBookingStatusUpdate,
  emitAdminEvent,
  serializeBooking
} = require("../sockets/bookingSocket");

const createBookingSchema = z.object({
  bookingCode: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(),
  serviceCategory: z.string().trim().min(1).max(80).optional(),
  serviceName: z.string().trim().max(120).optional(),
  issue: z.string().trim().max(500).optional(),
  address: z.string().trim().min(3).max(700),
  city: z.string().trim().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  price: z.coerce.number().min(0).max(1000000).optional(),
  slot: z.string().trim().max(120).optional(),
  userName: z.string().trim().max(120).optional(),
  userPhone: z.string().trim().max(20).optional(),
  phoneVerified: z.boolean().optional(),
  emergency: z.boolean().optional(),
  emergencyType: z.enum(["electric_short_circuit", "water_leakage", "ac_breakdown", "other"]).optional(),
  emergencyPriority: z.enum(["normal", "urgent", "critical"]).optional(),
  emergencyNotes: z.string().trim().max(500).optional()
});

const callActionSchema = z.object({
  action: z.enum(["start", "report"]),
  reason: z.string().optional()
});

const quoteCounterSchema = z.object({
  amount: z.coerce.number().positive(),
  message: z.string().max(250).optional()
});

const chatMonitorSchema = z.object({
  message: z.string().min(1).max(1000),
  clientMessageId: z.string().max(120).optional(),
  source: z.string().max(40).optional()
});

const noResponseReportSchema = z.object({
  reason: z.string().min(3).max(500),
  evidenceUrl: z.string().optional(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  accuracy: z.coerce.number().optional(),
  provider: z.string().optional(),
  isMock: z.boolean().optional(),
  recordedAt: z.coerce.number().optional()
});

const sosSchema = z.object({
  reason: z.enum(["emergency", "unsafe_location", "customer_issue", "accident", "other"]).optional(),
  note: z.string().max(500).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  accuracy: z.coerce.number().optional()
});

const proofPhotoSchema = z.object({
  stage: z.enum(["before", "after"]),
  note: z.string().max(500).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  accuracy: z.coerce.number().optional()
});

const revisitRequestSchema = z.object({
  reason: z.string().max(80).optional(),
  message: z.string().max(600).optional()
});

const acceptBookingSchema = z.object({
  arrivalEstimateMinutes: z.coerce.number().int().min(10).max(1440).default(30),
  arrivalEstimateLabel: z.string().trim().max(80).optional()
});

const QUOTE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const PARTNER_STATUS_UPDATES = ["on_the_way", "arrived", "started", "amount_pending", "completed", "cancelled"];
const CUSTOMER_STATUS_UPDATES = ["cancelled", "completed", "disputed"];

function normalizeStaffPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const phone = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(phone) ? phone : "";
}

function normalizeStaffEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function staffIdentityHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const secret = process.env.IDENTITY_HASH_PEPPER || process.env.ENCRYPTION_KEY || "apnaservo-dev-identity-hash";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

async function findLaundryStaffActor(auth) {
  const phone = normalizeStaffPhone(auth?.phone_number || "");
  const email = auth?.email_verified === true ? normalizeStaffEmail(auth?.email || "") : "";
  const phoneHash = staffIdentityHash(phone);
  const emailHash = staffIdentityHash(email);
  if ((!phone && !email) || auth?.development_device) return null;

  let partner = await Partner.findOne({
    businessType: "laundry",
    $or: [
      { "laundryBusiness.staffMembers.firebaseUid": auth.uid },
      ...(phoneHash ? [{ "laundryBusiness.staffMembers.phoneHash": phoneHash }] : []),
      ...(emailHash ? [{ "laundryBusiness.staffMembers.emailHash": emailHash }] : [])
    ]
  });
  // Legacy staff invitations may predate identity hashes. The fallback still
  // requires an exact Firebase-verified phone/email match; it only lets those
  // existing staff members transition safely to the current auth scheme.
  if (!partner) {
    const candidates = await Partner.find({ businessType: "laundry" }).limit(500);
    partner = candidates.find((candidate) => (candidate.laundryBusiness?.staffMembers || [])
      .some((member) => (phone && normalizeStaffPhone(member.phone) === phone)
        || (email && normalizeStaffEmail(member.email) === email)));
  }
  if (!partner) return null;
  const staff = (partner.laundryBusiness?.staffMembers || []).find((member) =>
    member.firebaseUid === auth.uid
      || (phoneHash && member.phoneHash === phoneHash)
      || (emailHash && member.emailHash === emailHash)
      || (phone && normalizeStaffPhone(member.phone) === phone)
      || (email && normalizeStaffEmail(member.email) === email)
  );
  if (!staff || ["blocked", "rejected"].includes(staff.verificationStatus)) return null;
  return { partner, staff };
}

function hasStatusLocationPayload(body = {}) {
  return Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng));
}

function bookingCode() {
  return `AS${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function serviceCategoryForEmergency(type) {
  if (type === "electric_short_circuit") return "electrician";
  if (type === "water_leakage") return "plumbing";
  if (type === "ac_breakdown") return "ac";
  return "service";
}

function fileDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

async function uploadProofToCloudinary(file, bookingId, stage) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return { storageProvider: "inline", url: "", cloudinaryPublicId: "" };
  }
  const result = await cloudinary.uploader.upload(fileDataUri(file), {
    folder: `apnaservo/job_proofs/${bookingId}`,
    public_id: `${stage}_${Date.now()}`,
    resource_type: "image",
    overwrite: false,
    quality: "auto:good",
    fetch_format: "auto"
  });
  return {
    storageProvider: "cloudinary",
    url: result.secure_url || result.url || "",
    cloudinaryPublicId: result.public_id || ""
  };
}

function warrantyDaysFor(booking) {
  const configured = Number(process.env.SERVICE_WARRANTY_DAYS || 7);
  if (Number.isFinite(configured) && configured >= 0 && configured <= 365) {
    return Math.floor(configured);
  }
  return booking?.emergency?.isEmergency ? 3 : 7;
}

function warrantyEndDateFrom(serviceDate, days) {
  return new Date(serviceDate.getTime() + days * 24 * 60 * 60 * 1000);
}

function serializeTracking({ booking, partner, latestLocation, recentLocations }) {
  const partnerLocation = partner?.location?.coordinates || [0, 0];
  return {
    bookingId: String(booking._id),
    bookingCode: booking.bookingCode,
    status: booking.status,
    partnerId: booking.partnerId ? String(booking.partnerId) : "",
    partnerName: booking.partnerSnapshot?.name || partner?.name || "",
    partnerPhoneMasked: maskPhone(booking.partnerSnapshot?.phone || partner?.phone || ""),
    lat: latestLocation?.lat || partnerLocation[1] || 0,
    lng: latestLocation?.lng || partnerLocation[0] || 0,
    accuracy: latestLocation?.accuracy || partner?.lastLocationAccuracy || 9999,
    provider: latestLocation?.provider || partner?.lastLocationProvider || "",
    updatedAt: latestLocation?.recordedAt || partner?.lastLocationAt || null,
    updatedAtMillis: latestLocation?.recordedAt ? new Date(latestLocation.recordedAt).getTime() : millis(partner?.lastLocationAt),
    trustStatus: partner?.locationTrustStatus || "unknown",
    recent: (recentLocations || []).map((entry) => ({
      lat: entry.lat,
      lng: entry.lng,
      accuracy: entry.accuracy,
      provider: entry.provider,
      recordedAt: entry.recordedAt,
      recordedAtMillis: millis(entry.recordedAt)
    }))
  };
}

function serializeProofPhoto(photo) {
  return {
    id: String(photo._id),
    bookingId: String(photo.bookingId),
    bookingCode: photo.bookingCode,
    stage: photo.stage,
    url: photo.url || "",
    storageProvider: photo.storageProvider,
    note: photo.note || "",
    lat: photo.lat,
    lng: photo.lng,
    createdAt: photo.createdAt ? photo.createdAt.toISOString() : ""
  };
}

function serializeRevisitRequest(request) {
  return {
    id: String(request._id),
    bookingId: String(request.bookingId),
    bookingCode: request.bookingCode,
    reason: request.reason,
    message: request.message || "",
    status: request.status,
    warrantyEndDate: request.warrantyEndDate ? request.warrantyEndDate.toISOString() : "",
    requestedAt: request.requestedAt ? request.requestedAt.toISOString() : ""
  };
}

function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return "Protected";
  const last = digits.slice(-4);
  const prefix = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
  return `${prefix}******${last}`;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function identityHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const secret = process.env.IDENTITY_HASH_PEPPER || process.env.ENCRYPTION_KEY || "apnaservo-dev-identity-hash";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

function firebasePhoneVerified(req, phone) {
  const tokenPhone = normalizePhone(req.auth?.phone_number);
  const customerPhone = normalizePhone(phone);
  return tokenPhone.length === 10 && customerPhone.length === 10 && tokenPhone === customerPhone;
}

function requireCustomerOtp() {
  return String(process.env.REQUIRE_CUSTOMER_PHONE_OTP || "").toLowerCase() === "true";
}

function virtualCallNumber() {
  return String(process.env.VIRTUAL_CALL_NUMBER || process.env.APNA_SERVO_VIRTUAL_CALL_NUMBER || "").trim();
}

function bookingIdFilter(bookingId) {
  return mongoose.Types.ObjectId.isValid(bookingId)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(bookingId) }, { bookingCode: bookingId }] }
    : { bookingCode: bookingId };
}

function quoteExpiresAtFrom(now = new Date()) {
  return new Date(now.getTime() + QUOTE_EXPIRY_MS);
}

function isQuoteExpired(booking, now = new Date()) {
  if (!booking || booking.quoteStatus !== "pending" || !booking.quoteExpiresAt) {
    return false;
  }
  return new Date(booking.quoteExpiresAt).getTime() <= now.getTime();
}

function approvalQuoteStatus(booking) {
  if (!booking) return "none";
  if (booking.quoteStatus && booking.quoteStatus !== "none") {
    return booking.quoteStatus;
  }
  return booking.status === "amount_pending" ? "pending" : "none";
}

async function expireQuoteIfNeeded(booking, options = {}) {
  if (!isQuoteExpired(booking)) {
    return false;
  }
  booking.quoteStatus = "expired";
  booking.status = "started";
  booking.paymentStatus = "pending";
  booking.statusTimeline.push({ status: "quote_expired", at: new Date(), by: "system" });
  booking.quoteHistory.push({
    kind: "quote_expired",
    amount: Number(booking.quoteAmount || booking.finalAmount || 0),
    by: "system",
    message: "Quote expired after 24 hours",
    at: new Date()
  });
  await booking.save();
  if (options.emit) {
    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:quote_expired", serializeBooking(booking));
  }
  return true;
}

async function expireQuotesIfNeeded(bookings) {
  for (const booking of bookings) {
    await expireQuoteIfNeeded(booking);
  }
  return bookings;
}

function commissionRate() {
  const value = Number(process.env.APP_COMMISSION_RATE || 0.1);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.1;
}

async function upsertCommissionLedger(booking) {
  if (!booking?.partnerId || !booking?.userId) {
    return null;
  }
  const grossAmount = Math.round(Number(booking.finalAmount || booking.price || 0));
  const rate = commissionRate();
  const commissionAmount = Math.round(grossAmount * rate);
  const netPayable = Math.max(0, grossAmount - commissionAmount);
  return CommissionLedger.findOneAndUpdate(
    { bookingId: booking._id },
    {
      $set: {
        bookingCode: booking.bookingCode,
        partnerId: booking.partnerId,
        userId: booking.userId,
        grossAmount,
        commissionRate: rate,
        commissionAmount,
        netPayable,
        status: "pending",
        source: "booking_completion",
        completedAt: booking.completedAt || new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function creditCompletedBookingOnce(booking) {
  if (!booking?.partnerId || !booking?.userId || booking.status !== "completed") {
    return false;
  }
  const grossAmount = Math.round(Number(booking.finalAmount || booking.price || 0));
  const creditedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, "completionAccounting.creditedAt": null },
    {
      $set: {
        "completionAccounting.creditedAt": new Date(),
        "completionAccounting.grossAmount": grossAmount
      }
    },
    { new: true }
  );
  if (!creditedBooking) {
    return false;
  }
  await Partner.findByIdAndUpdate(booking.partnerId, {
    $inc: { totalJobs: 1, earnings: grossAmount }
  });
  await upsertCommissionLedger(creditedBooking);
  return true;
}

function protectCustomerPhoneForPartner(payload, booking, partner) {
  const assigned = partner && String(booking.partnerId || "") === String(partner._id);
  const customerPhone = assigned ? String(booking.userSnapshot?.phone || payload.userPhone || "") : "";
  return {
    ...payload,
    userPhone: customerPhone || maskPhone(booking.userSnapshot?.phone || payload.userPhone),
    customerPhone: customerPhone,
    customerPhoneMasked: customerPhone || maskPhone(booking.userSnapshot?.phone || payload.userPhone),
    phoneProtected: !assigned,
    virtualCalling: Boolean(virtualCallNumber())
  };
}

function partnerCategoryVariants(partner) {
  const categories = [...new Set((partner.serviceCategory || [])
    .map(normalizeServiceCategory)
    .filter((category) => category && category !== "service"))];
  // A company profile is a single operating service. An ambiguous legacy
  // record receives no new work until its category is normalized, rather than
  // falling back to Laundry or whichever value happens to come first.
  if (partner?.businessType === "laundry") {
    const selected = companySingleServiceCategory(partner);
    return selected ? serviceCategoryVariants(selected) : [];
  }
  return [...new Set(categories.flatMap(serviceCategoryVariants))];
}

function partnerOpenBookingVisibility(partner, categories) {
  return {
    partnerId: null,
    rejectedPartners: { $ne: partner._id },
    status: { $in: pendingAssignmentStatuses() },
    serviceCategory: { $in: categories },
    requestedPartners: partner._id
  };
}

function partnerAcceptBlockReason(partner) {
  if (!partner) return "Partner profile not found";
  if (partner.accountStatus !== "active") return "Partner account is not active";
  if (partner.trustStatus === "suspended") return "Partner account is suspended";
  if (!partner.isVerified || partner.kycStatus !== "verified" || partner.trustStatus !== "trusted") {
    return "ApnaServo admin approval is pending. Keep your device online after approval to receive bookings.";
  }
  if (!partner.isOnline) return "Go online before accepting new jobs";
  if (!partner.phone) return "Add a phone number before accepting jobs";
  if (!Array.isArray(partner.serviceCategory) || partner.serviceCategory.length === 0) {
    return "Select at least one service before accepting jobs";
  }
  return "";
}

function partnerCanViewOpenJobs(partner) {
  if (!partner) return false;
  if (partner.accountStatus !== "active") return false;
  if (partner.trustStatus === "suspended") return false;
  if (!partner.isVerified || partner.kycStatus !== "verified" || partner.trustStatus !== "trusted") return false;
  if (!partner.isOnline) return false;
  return Array.isArray(partner.serviceCategory) && partner.serviceCategory.length > 0;
}

function userRecipient(user) {
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

function partnerRecipient(partner) {
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

function emergencyPayload(body) {
  const type = body.emergencyType || "none";
  const isEmergency = Boolean(body.emergency || type !== "none");
  return {
    isEmergency,
    type: isEmergency ? type : "none",
    priority: isEmergency ? (body.emergencyPriority || (type === "electric_short_circuit" ? "critical" : "urgent")) : "normal",
    notes: body.emergencyNotes || "",
    requestedAt: isEmergency ? new Date() : null
  };
}

async function dispatchBookingToPartners(booking, category, lat, lng) {
  let match = { partners: [], radiusKm: 0, mode: "" };
  try {
    match = await findNearbyPartners.withMetadata({
      serviceCategory: category,
      city: booking.city,
      lat,
      lng,
      excludePartnerIds: booking.rejectedPartners || []
    });
  } catch (error) {
    console.error("Partner matching failed", {
      bookingId: String(booking._id),
      bookingCode: booking.bookingCode,
      message: error.message
    });
    emitNewBookingToPartners(booking, []);
    return match.partners;
  }
  const partners = match.partners;

  if (!partners.length) {
    emitNewBookingToPartners(booking, []);
    return partners;
  }

  if (!booking.requestedPartners || booking.requestedPartners.length === 0) {
    const claimedBooking = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        partnerId: null,
        requestedPartners: { $size: 0 },
        status: { $in: pendingAssignmentStatuses() }
      },
      {
        $set: {
          requestedPartners: partners.map((partner) => partner._id),
          status: "sent_to_partner",
          dispatchRadiusKm: match.radiusKm,
          dispatchMode: match.mode,
          dispatchedAt: new Date()
        },
        $inc: { dispatchAttempt: 1 },
        $push: {
          statusTimeline: {
            status: "sent_to_partner",
            at: new Date(),
            by: "system",
            note: match.mode === "customer_location"
              ? `Matched verified partners within ${match.radiusKm} km`
              : "Matched verified partners using city fallback"
          }
        }
      },
      { new: true }
    );
    if (!claimedBooking) {
      return [];
    }

    emitNewBookingToPartners(claimedBooking, partners);
    await reliableNotify({
      recipients: partners.map(partnerRecipient),
      title: claimedBooking.emergency?.isEmergency ? "Emergency Booking Request" : "New Booking Request",
      body: claimedBooking.emergency?.isEmergency
        ? `${claimedBooking.serviceName} emergency near ${claimedBooking.city}`
        : `${claimedBooking.serviceName} near ${claimedBooking.city}`,
      category: claimedBooking.emergency?.isEmergency ? "emergency_booking" : "booking_request",
      priority: "high",
      data: {
        type: claimedBooking.emergency?.isEmergency ? "booking:emergency_request" : "booking:new_request",
        bookingId: claimedBooking._id,
        bookingCode: claimedBooking.bookingCode,
        serviceCategory: claimedBooking.serviceCategory,
        emergencyType: claimedBooking.emergency?.type || "none",
        emergencyPriority: claimedBooking.emergency?.priority || "normal"
      },
      smsBody: claimedBooking.emergency?.isEmergency
        ? `ApnaServo Emergency: ${claimedBooking.serviceName} near ${claimedBooking.city}. Open partner app now.`
        : ""
    });
  }

  return partners;
}

function queueBookingDispatch(booking, category, lat, lng) {
  const bookingId = booking?._id;
  if (!bookingId) return;
  setImmediate(async () => {
    try {
      const current = await Booking.findById(bookingId);
      if (!current || current.partnerId || current.requestedPartners?.length) return;
      await dispatchBookingToPartners(current, category, lat, lng);
    } catch (error) {
      console.error("Queued partner dispatch failed", {
        bookingId: String(bookingId),
        message: error.message
      });
    }
  });
}

async function getOrCreateUser(req, body) {
  const existing = await User.findOne({ firebaseUid: req.auth.uid })
    .select("_id phone phoneVerified phoneVerifiedAt")
    .lean();
  const phone = body.userPhone || req.auth.phone_number || existing?.phone || "";
  const normalizedPhone = normalizePhone(phone);
  const email = normalizeEmail(req.auth.email || "");
  const verified = firebasePhoneVerified(req, phone)
    || Boolean(existing?.phoneVerified && normalizePhone(existing.phone) === normalizedPhone);
  const now = new Date();
  const update = {
    $set: {
      name: body.userName || req.auth.name || "ApnaServo Customer",
      phone,
      phoneHash: normalizedPhone.length === 10 ? identityHash(normalizedPhone) : "",
      email,
      emailHash: identityHash(email),
      city: body.city || "Guwahati",
      address: body.address || "",
      bookingRiskStatus: verified ? "trusted" : "otp_required",
      lastLoginAt: now,
      location: {
        type: "Point",
        coordinates: [Number(body.lng || 91.7362), Number(body.lat || 26.1445)]
      }
    },
    $setOnInsert: {
      registrationHistory: [{
        source: "booking_create",
        provider: "firebase",
        registeredAt: now,
        ip: req.ip || "",
        userAgent: req.get("user-agent") || ""
      }]
    }
  };
  if (verified) {
    update.$set.phoneVerified = true;
    update.$set.phoneVerifiedAt = new Date();
  } else {
    update.$set.phoneVerified = false;
    update.$set.phoneVerifiedAt = null;
  }
  const user = await User.findOneAndUpdate(
    { firebaseUid: req.auth.uid },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const normalizedAddress = String(body.address || "").trim().toLowerCase();
  const alreadySaved = normalizedAddress && (user.savedAddresses || []).some(
    (entry) => String(entry.address || "").trim().toLowerCase() === normalizedAddress
  );
  if (normalizedAddress && !alreadySaved) {
    user.savedAddresses.push({
      label: user.savedAddresses.length ? "Service address" : "Primary",
      address: body.address,
      city: body.city || "Guwahati",
      location: {
        type: "Point",
        coordinates: [Number(body.lng || 91.7362), Number(body.lat || 26.1445)]
      },
      isDefault: user.savedAddresses.length === 0,
      updatedAt: now
    });
    await user.save();
  }
  if (!existing) {
    emitAdminEvent("user:registered", {
      userId: String(user._id),
      name: user.name,
      phone: user.phone,
      email: user.email,
      createdAt: user.createdAt
    });
  }
  return user;
}

async function createBooking(req, res, next) {
  try {
    const body = createBookingSchema.parse(req.body || {});
    const user = await getOrCreateUser(req, body);
    if (requireCustomerOtp() && !user.phoneVerified) {
      await User.findByIdAndUpdate(user._id, {
        $inc: { fakeBookingWarningCount: 1 },
        $set: { bookingRiskStatus: "otp_required" }
      });
      return res.status(403).json({ message: "Phone OTP verification required before booking" });
    }
    const category = normalizeServiceCategory(body.serviceCategory || serviceCategoryForEmergency(body.emergencyType));
    const hasCustomerLocation = findNearbyPartners.validCoordinates(body.lat, body.lng);
    const lat = hasCustomerLocation ? Number(body.lat) : 26.1445;
    const lng = hasCustomerLocation ? Number(body.lng) : 91.7362;
    const dispatchLat = hasCustomerLocation ? lat : null;
    const dispatchLng = hasCustomerLocation ? lng : null;
    const requestedBookingCode = body.bookingCode || bookingCode();
    const emergency = emergencyPayload(body);

    const existingBooking = await Booking.findOne({ bookingCode: requestedBookingCode });
    if (existingBooking) {
      if (String(existingBooking.userId) !== String(user._id)) {
        return res.status(409).json({ message: "Booking code already exists" });
      }

      if (!existingBooking.requestedPartners?.length && !existingBooking.partnerId) {
        queueBookingDispatch(existingBooking, existingBooking.serviceCategory || category, dispatchLat, dispatchLng);
      }

      return res.status(200).json({
        booking: serializeBooking(existingBooking),
        matchedPartners: existingBooking.requestedPartners?.length || 0,
        dispatchQueued: !existingBooking.requestedPartners?.length && !existingBooking.partnerId,
        idempotent: true
      });
    }

    let booking;
    try {
      booking = await Booking.create({
        bookingCode: requestedBookingCode,
        userId: user._id,
        serviceCategory: category,
        serviceName: body.serviceName || serviceLabel(category),
        issue: body.issue || `Customer requested ${serviceLabel(category)} inspection`,
        address: body.address,
        city: body.city || "Guwahati",
        location: { type: "Point", coordinates: [lng, lat] },
        price: body.price || 0,
        slot: body.slot || "",
        status: "pending",
        emergency,
        userSnapshot: {
          name: body.userName || user.name,
          phone: body.userPhone || user.phone,
          email: user.email,
          fcmToken: user.fcmToken
        },
        customerVerification: {
          phoneVerified: Boolean(user.phoneVerified),
          otpRequired: requireCustomerOtp(),
          authPhone: req.auth.phone_number || "",
          verifiedAt: user.phoneVerifiedAt || null,
          riskStatus: user.phoneVerified ? "trusted" : "otp_required"
        },
        statusTimeline: [{ status: emergency.isEmergency ? "emergency_requested" : "pending", at: new Date(), by: "user" }]
      });
    } catch (createError) {
      if (createError?.code === 11000) {
        const duplicate = await Booking.findOne({ bookingCode: requestedBookingCode });
        if (duplicate && String(duplicate.userId) === String(user._id)) {
          if (!duplicate.requestedPartners?.length && !duplicate.partnerId) {
            queueBookingDispatch(duplicate, duplicate.serviceCategory || category, dispatchLat, dispatchLng);
          }
          return res.status(200).json({
            booking: serializeBooking(duplicate),
            matchedPartners: duplicate.requestedPartners?.length || 0,
            dispatchQueued: !duplicate.requestedPartners?.length && !duplicate.partnerId,
            idempotent: true
          });
        }
      }
      throw createError;
    }

    emitAdminEvent("booking:new_request", serializeBooking(booking));
    queueBookingDispatch(booking, category, dispatchLat, dispatchLng);
    User.findByIdAndUpdate(user._id, { $set: { lastBookingAt: new Date() } }).catch((error) => {
      console.error("Failed to update user last booking time", { userId: String(user._id), message: error.message });
    });

    return res.status(201).json({
      booking: serializeBooking(booking),
      matchedPartners: 0,
      dispatchQueued: true
    });
  } catch (error) {
    return next(error);
  }
}

async function listUserBookings(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) return res.json({ bookings: [] });
    const identityFilters = [];
    if (user.phoneHash) identityFilters.push({ phoneHash: user.phoneHash });
    if (req.auth.email_verified === true && user.emailHash) identityFilters.push({ emailHash: user.emailHash });
    const linkedUsers = identityFilters.length
      ? await User.find({ $or: identityFilters }).select("_id")
      : [];
    const userIds = [...new Set([String(user._id), ...linkedUsers.map((entry) => String(entry._id))])];
    const bookings = await Booking.find({ userId: { $in: userIds } }).sort({ createdAt: -1 });
    await expireQuotesIfNeeded(bookings);
    return res.json({ bookings: bookings.map(serializeBooking) });
  } catch (error) {
    return next(error);
  }
}

async function listPartnerBookings(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.json({ bookings: [] });

    const categories = partnerCategoryVariants(partner);
    const canViewOpenJobs = partnerCanViewOpenJobs(partner);
    const companyServiceFilter = partner.businessType === "laundry"
      ? { serviceCategory: { $in: categories } }
      : {};
    const bookings = await Booking.find({
      $or: [
        { partnerId: partner._id, ...companyServiceFilter },
        {
          partnerId: null,
          requestedPartners: partner._id,
          rejectedPartners: { $ne: partner._id },
          status: { $in: pendingAssignmentStatuses() }
        },
        canViewOpenJobs ? partnerOpenBookingVisibility(partner, categories) : { _id: null }
      ]
    }).sort({ createdAt: -1 }).limit(80);

    await expireQuotesIfNeeded(bookings);
    return res.json({ bookings: bookings.map((booking) => protectCustomerPhoneForPartner(serializeBooking(booking), booking, partner)) });
  } catch (error) {
    return next(error);
  }
}

async function acceptBooking(req, res, next) {
  try {
    const acceptDetails = acceptBookingSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.status(404).json({ message: "Partner profile not found" });
    const blockReason = partnerAcceptBlockReason(partner);
    if (blockReason) {
      return res.status(403).json({ message: blockReason });
    }

    const bookingId = req.params.bookingId;
    const acceptedAt = new Date();
    const expectedArrivalAt = new Date(acceptedAt.getTime() + acceptDetails.arrivalEstimateMinutes * 60 * 1000);
    const arrivalEstimateLabel = acceptDetails.arrivalEstimateLabel
      || `${acceptDetails.arrivalEstimateMinutes} minutes`;
    const idFilter = bookingIdFilter(bookingId);
    const query = {
      partnerId: null,
      $and: [
        idFilter,
        partnerOpenBookingVisibility(partner, partnerCategoryVariants(partner))
      ]
    };

    const booking = await Booking.findOneAndUpdate(
      query,
      {
        $set: {
          partnerId: partner._id,
          status: "accepted",
          acceptedAt,
          partnerArrivalEstimateMinutes: acceptDetails.arrivalEstimateMinutes,
          partnerArrivalEstimateLabel: arrivalEstimateLabel,
          expectedArrivalAt,
          partnerSnapshot: {
            name: partner.name,
            phone: partner.phone,
            rating: partner.rating,
            ratingCount: partner.ratingCount || 0,
            photoUrl: partner.photoUrl || partner.selfieUrl || "",
            fcmToken: partner.fcmToken
          }
        },
        $push: { statusTimeline: { status: "accepted", at: acceptedAt, by: "partner" } }
      },
      { new: true }
    );

    if (!booking) {
      const current = await Booking.findOne(idFilter);
      if (current && String(current.partnerId || "") === String(partner._id)) {
        return res.json({ booking: serializeBooking(current), idempotent: true });
      }
      return res.status(409).json({ message: "Booking already accepted or unavailable" });
    }

    emitBookingAccepted(booking, partner);

    const user = await User.findById(booking.userId);
    await reliableNotify({
      recipients: [userRecipient(user)],
      title: "Partner Assigned",
      body: `${partner.name} has been assigned and expects to arrive in ${arrivalEstimateLabel}`,
      category: "booking_assigned",
      priority: "high",
      data: { type: "booking:accepted", bookingId: booking._id, bookingCode: booking.bookingCode },
      smsBody: `ApnaServo: ${partner.name} has been assigned for booking ${booking.bookingCode} and expects to arrive in ${arrivalEstimateLabel}.`
    });

    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function rejectBooking(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.status(404).json({ message: "Partner profile not found" });
    const blockReason = partnerAcceptBlockReason(partner);
    if (blockReason) {
      return res.status(403).json({ message: blockReason });
    }

    const now = new Date();
    const booking = await Booking.findOneAndUpdate(
      {
        $and: [
          bookingIdFilter(String(req.params.bookingId || "")),
          partnerOpenBookingVisibility(partner, partnerCategoryVariants(partner))
        ],
        status: { $in: pendingAssignmentStatuses() },
        partnerId: null
      },
      {
        $addToSet: { rejectedPartners: partner._id },
        $push: { statusTimeline: { status: "rejected", at: now, by: "partner" } }
      },
      { new: true }
    );

    if (booking) {
      const requestedIds = (booking.requestedPartners || []).map((id) => String(id));
      const rejectedIds = new Set((booking.rejectedPartners || []).map((id) => String(id)));
      const allRequestedRejected = requestedIds.length > 0 && requestedIds.every((id) => rejectedIds.has(id));
      if (allRequestedRejected && !booking.partnerId && booking.status === "sent_to_partner") {
        booking.status = "pending";
        booking.requestedPartners = [];
        booking.statusTimeline.push({ status: "awaiting_partner_after_rejection", at: now, by: "system" });
        await booking.save();
        const coordinates = booking.location?.coordinates || [];
        queueBookingDispatch(
          booking,
          booking.serviceCategory,
          findNearbyPartners.validCoordinates(coordinates[1], coordinates[0]) ? coordinates[1] : null,
          findNearbyPartners.validCoordinates(coordinates[1], coordinates[0]) ? coordinates[0] : null
        );
      }
      emitBookingRejected(booking, partner._id);
    }

    return res.json({ ok: true, booking: booking ? serializeBooking(booking) : null });
  } catch (error) {
    return next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    const requestedStatus = String(req.body?.status || "");
    const nextStatus = normalizeBookingStatusInput(requestedStatus);
    if (!nextStatus || !BOOKING_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid booking status" });
    }

    // Resolve a company-staff identity first. This prevents an old independent
    // partner profile on the same Firebase account from accidentally granting
    // owner-level status permissions to an assigned staff member.
    const staffActor = await findLaundryStaffActor(req.auth);
    const partner = staffActor ? null : await Partner.findOne({ firebaseUid: req.auth.uid });
    const actingPartner = partner || staffActor?.partner || null;
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    const query = bookingIdFilter(String(req.params.bookingId || ""));
    const finalAmount = Number(req.body?.finalAmount || 0);
    const now = new Date();
    let actorRole = "";
    if (partner) {
      if (!PARTNER_STATUS_UPDATES.includes(nextStatus)) {
        return res.status(403).json({ message: "Partner cannot apply this booking status" });
      }
      actorRole = "partner";
      query.partnerId = partner._id;
    } else if (staffActor) {
      if (!PARTNER_STATUS_UPDATES.includes(nextStatus)) {
        return res.status(403).json({ message: "Staff cannot apply this booking status" });
      }
      if (nextStatus === "cancelled") {
        return res.status(403).json({ message: "Assigned staff cannot cancel a company order" });
      }
      actorRole = "staff";
      query.partnerId = staffActor.partner._id;
    } else if (user && CUSTOMER_STATUS_UPDATES.includes(nextStatus)) {
      actorRole = "user";
      query.userId = user._id;
    } else {
      return res.status(403).json({ message: "Not allowed to update this booking" });
    }

    const currentBooking = await Booking.findOne(query);
    if (!currentBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (partner?.businessType === "laundry") {
      return res.status(403).json({ message: "Laundry owners can accept and assign orders only. The assigned staff member updates live status." });
    }
    if (staffActor) {
      const assignment = currentBooking.laundryAssignment || {};
      const assignedToStaff = Number(assignment.staffSequence || 0) === Number(staffActor.staff.sequence || 0)
        || (assignment.staffFirebaseUid && assignment.staffFirebaseUid === req.auth.uid)
        || (assignment.staffPhoneHash && assignment.staffPhoneHash === staffIdentityHash(normalizeStaffPhone(req.auth?.phone_number || "")))
        || (assignment.staffEmailHash && assignment.staffEmailHash === staffIdentityHash(req.auth?.email_verified === true ? normalizeStaffEmail(req.auth.email) : ""));
      if (!assignedToStaff) {
        return res.status(403).json({ message: "Only the staff member assigned to this order can update its live status" });
      }
    }

    if (currentBooking.status === "completed" && nextStatus === "completed") {
      return res.json({ booking: serializeBooking(currentBooking), idempotent: true });
    }

    if (nextStatus === "amount_pending") {
      if (!actingPartner) {
        return res.status(403).json({ message: "Only assigned staff can request the final amount" });
      }
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return res.status(400).json({ message: "Final amount required" });
      }
    }

    const expiredQuote = await expireQuoteIfNeeded(currentBooking, { emit: true });
    if (expiredQuote && nextStatus === "completed") {
      return res.status(410).json({ message: "Quote expired. Ask partner to send a fresh quote." });
    }

    const decision = transitionDecision({
      currentStatus: currentBooking.status,
      nextStatus,
      actorRole,
      quoteStatus: currentBooking.quoteStatus
    });
    if (!decision.ok) {
      return res.status(409).json({ message: decision.reason });
    }

    if (decision.idempotent) {
      if (nextStatus === "amount_pending") {
        const currentAmount = Number(currentBooking.finalAmount || currentBooking.quoteAmount || 0);
        if (Math.round(finalAmount) !== Math.round(currentAmount)) {
          return res.status(409).json({ message: "A quote is already pending customer approval" });
        }
      }
      return res.json({ booking: serializeBooking(currentBooking), idempotent: true });
    }

    if (nextStatus === "completed") {
      const quoteStatus = approvalQuoteStatus(currentBooking);
      if (actingPartner && quoteStatus !== "payment_submitted") {
        return res.status(409).json({ message: "Customer payment confirmation is pending" });
      }
      if (!actingPartner && quoteStatus !== "pending") {
        return res.status(409).json({ message: "Quote is not ready for approval" });
      }
      if (currentBooking.quoteExpiresAt && new Date(currentBooking.quoteExpiresAt).getTime() <= now.getTime()) {
        return res.status(410).json({ message: "Quote expired. Ask partner to send a fresh quote." });
      }
    }

    if (actingPartner && ["on_the_way", "arrived", "started"].includes(nextStatus) && hasStatusLocationPayload(req.body)) {
      const validation = validatePartnerLocation({
        partner: actingPartner,
        booking: currentBooking,
        payload: req.body || {},
        requireNearCustomer: nextStatus === "arrived"
      });
      await LocationLog.create({
        partnerId: actingPartner._id,
        bookingId: currentBooking._id,
        bookingCode: currentBooking.bookingCode,
        lat: Number.isFinite(validation.lat) ? validation.lat : 0,
        lng: Number.isFinite(validation.lng) ? validation.lng : 0,
        accuracy: validation.accuracy,
        provider: validation.provider,
        isMock: validation.isMock,
        validationStatus: validation.valid ? "accepted" : "rejected",
        reason: validation.reason,
        speedMps: validation.speedMps,
        distanceToCustomerM: validation.distanceToCustomerM,
        recordedAt: validation.recordedAt
      });
      if (!validation.valid) {
        await Partner.findByIdAndUpdate(actingPartner._id, { $set: { locationTrustStatus: "suspicious" } });
        console.warn("Ignoring non-blocking status location validation failure", {
          bookingId: String(currentBooking._id),
          partnerId: String(actingPartner._id),
          status: nextStatus,
          reason: validation.reason
        });
      } else {
        await Partner.findByIdAndUpdate(actingPartner._id, { $set: partnerLocationUpdate(validation) });
      }
    }

    const update = {
      $set: { status: nextStatus },
      $push: { statusTimeline: { status: nextStatus, at: now, by: staffActor ? "laundry_staff" : (partner ? "partner" : "user") } }
    };
    if (nextStatus === "amount_pending") {
      const quoteExpiresAt = quoteExpiresAtFrom(now);
      const roundedFinalAmount = Math.round(finalAmount);
      update.$set.finalAmount = roundedFinalAmount;
      update.$set.quoteAmount = roundedFinalAmount;
      update.$set.quoteStatus = "pending";
      update.$set.quoteRequestedAt = now;
      update.$set.quoteExpiresAt = quoteExpiresAt;
      update.$set.quoteApprovedAt = null;
      update.$set.quoteCounterAmount = 0;
      update.$set.quoteCounterMessage = "";
      update.$set.quoteCounterAt = null;
      update.$set.paymentStatus = "pending";
      update.$set.amountRequestedAt = now;
      update.$push.quoteHistory = {
        kind: "partner_quote",
        amount: roundedFinalAmount,
        by: staffActor ? "laundry_staff" : "partner",
        message: staffActor ? "Assigned laundry staff sent price quote" : "Partner sent price quote",
        at: now
      };
    }
    if (staffActor) {
      const staffTaskStatus = {
        on_the_way: "on_the_way",
        arrived: "picked_up",
        started: "out_for_delivery",
        amount_pending: "delivered",
        completed: "completed"
      }[nextStatus];
      if (staffTaskStatus) {
        update.$set["laundryAssignment.taskStatus"] = staffTaskStatus;
      }
      if (nextStatus === "completed") {
        update.$set["laundryAssignment.completedAt"] = now;
      }
    }
    if (nextStatus === "completed") {
      const approvedAmount = Math.round(Number(currentBooking.finalAmount || currentBooking.quoteAmount || currentBooking.price || 0));
      const warrantyDays = warrantyDaysFor(currentBooking);
      update.$set.completedAt = now;
      update.$set.paymentStatus = "paid";
      update.$set.quoteStatus = "approved";
      update.$set.quoteApprovedAt = now;
      update.$set.finalAmount = approvedAmount;
      update.$set.quoteAmount = approvedAmount;
      update.$set["warranty.eligible"] = warrantyDays > 0;
      update.$set["warranty.serviceDate"] = now;
      update.$set["warranty.warrantyDays"] = warrantyDays;
      update.$set["warranty.warrantyEndDate"] = warrantyDays > 0 ? warrantyEndDateFrom(now, warrantyDays) : null;
      update.$set["warranty.revisitRequested"] = false;
      update.$push.quoteHistory = {
        kind: "quote_approved",
        amount: approvedAmount,
        by: actingPartner ? (staffActor ? "laundry_staff" : "partner") : "user",
        message: actingPartner ? (staffActor ? "Assigned laundry staff verified direct payment" : "Partner verified direct payment") : "Customer approved price quote",
        at: now
      };
    }

    const atomicQuery = {
      _id: currentBooking._id,
      status: currentBooking.status,
      ...(actingPartner ? { partnerId: actingPartner._id } : { userId: user._id })
    };
    if (nextStatus === "completed") {
      atomicQuery.quoteStatus = "pending";
      if (actingPartner) {
        atomicQuery.quoteStatus = "payment_submitted";
      }
    }
    if (nextStatus === "amount_pending" && currentBooking.status === "amount_pending") {
      atomicQuery.quoteStatus = currentBooking.quoteStatus;
    }

    const booking = await Booking.findOneAndUpdate(atomicQuery, update, { new: true });
    if (!booking) {
      return res.status(409).json({ message: "Booking changed on another device. Refresh and try again." });
    }

    if (nextStatus === "completed" && booking.partnerId) {
      await creditCompletedBookingOnce(booking);
    }

    emitBookingStatusUpdate(booking);
    if (nextStatus === "amount_pending") {
      emitAdminEvent("booking:quote_sent", serializeBooking(booking));
    } else if (nextStatus === "completed") {
      emitAdminEvent("booking:payment_accepted", serializeBooking(booking));
      emitAdminEvent("booking:completed", serializeBooking(booking));
    } else if (nextStatus === "cancelled" || nextStatus === "canceled") {
      emitAdminEvent("booking:cancelled", serializeBooking(booking));
    } else if (nextStatus === "disputed") {
      emitAdminEvent("booking:disputed", serializeBooking(booking));
    }

    const userForNotification = await User.findById(booking.userId);
    if (["on_the_way", "arrived", "started", "amount_pending", "completed"].includes(nextStatus)) {
      const statusNotificationCopy = {
        on_the_way: {
          title: "Partner On The Way",
          body: `${booking.serviceName} partner is on the way.`
        },
        arrived: {
          title: "Partner Arrived",
          body: `${booking.serviceName} partner has arrived at your location.`
        },
        started: {
          title: "Service Started",
          body: `${booking.serviceName} work has started.`
        },
        amount_pending: {
          title: "Approve Price Quote",
          body: `Partner sent Rs ${booking.finalAmount}. Approve within 24 hours or send a counter offer.`
        },
        completed: {
          title: "Booking Completed",
          body: `${booking.serviceName} is completed.`
        }
      };
      const notificationTitle = statusNotificationCopy[nextStatus].title;
      const notificationBody = statusNotificationCopy[nextStatus].body;
      await reliableNotify({
        recipients: [userRecipient(userForNotification)],
        title: notificationTitle,
        body: notificationBody,
        category: "booking_status",
        priority: "high",
        data: { type: "booking:status_update", status: nextStatus, bookingId: booking._id, bookingCode: booking.bookingCode },
        smsBody: `ApnaServo: ${notificationBody} Booking ${booking.bookingCode}.`
      });
    }

    if (["cancelled", "disputed"].includes(nextStatus)) {
      const partnerForNotification = booking.partnerId ? await Partner.findById(booking.partnerId) : null;
      const recipients = partner
        ? [userRecipient(userForNotification)]
        : [partnerRecipient(partnerForNotification)].filter(Boolean);
      const notificationTitle = nextStatus === "disputed" ? "Booking Disputed" : "Booking Cancelled";
      const notificationBody = nextStatus === "disputed"
        ? `Customer raised a dispute for booking ${booking.bookingCode}.`
        : `Booking ${booking.bookingCode} was cancelled.`;
      await reliableNotify({
        recipients,
        title: notificationTitle,
        body: notificationBody,
        category: "booking_status",
        priority: "high",
        data: { type: "booking:status_update", status: nextStatus, bookingId: booking._id, bookingCode: booking.bookingCode },
        smsBody: `ApnaServo: ${notificationBody}`
      });
    }

    if (!actingPartner && nextStatus === "completed" && booking.partnerId) {
      const partnerForNotification = await Partner.findById(booking.partnerId);
      await reliableNotify({
        recipients: [partnerRecipient(partnerForNotification)],
        title: "Payment Confirmed",
        body: `Customer confirmed Rs ${booking.finalAmount || booking.price || 0}`,
        category: "payment",
        priority: "high",
        data: { type: "booking:status_update", status: "completed", bookingId: booking._id, bookingCode: booking.bookingCode },
        smsBody: `ApnaServo: Customer confirmed Rs ${booking.finalAmount || booking.price || 0} for booking ${booking.bookingCode}.`
      });
    }

    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function counterOfferQuote(req, res, next) {
  try {
    const body = quoteCounterSchema.parse(req.body || {});
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "Customer profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      userId: user._id,
      status: "amount_pending"
    });
    if (!booking) {
      return res.status(404).json({ message: "Pending quote not found" });
    }
    if (await expireQuoteIfNeeded(booking, { emit: true })) {
      return res.status(410).json({ message: "Quote expired. Ask partner to send a fresh quote." });
    }
    const quoteStatus = approvalQuoteStatus(booking);
    if (quoteStatus !== "pending") {
      return res.status(409).json({ message: "Quote is not open for counter offer" });
    }

    const now = new Date();
    booking.quoteStatus = "countered";
    booking.quoteCounterAmount = Math.round(Number(body.amount));
    booking.quoteCounterMessage = body.message || "";
    booking.quoteCounterAt = now;
    booking.statusTimeline.push({ status: "quote_countered", at: now, by: "user" });
    booking.quoteHistory.push({
      kind: "counter_offer",
      amount: booking.quoteCounterAmount,
      by: "user",
      message: booking.quoteCounterMessage,
      at: now
    });
    await booking.save();

    const fraudScan = await recordFraudSignal({
      booking,
      userId: user._id,
      actorRole: "user",
      source: "quote_counter",
      message: body.message || "",
      metadata: { counterAmount: booking.quoteCounterAmount }
    });

    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:quote_countered", serializeBooking(booking));

    if (booking.partnerId) {
      const partner = await Partner.findById(booking.partnerId);
      await reliableNotify({
        recipients: [partnerRecipient(partner)],
        title: "Counter Offer Received",
        body: `Customer offered Rs ${booking.quoteCounterAmount} for ${booking.serviceName}.`,
        category: "quote",
        priority: "high",
        data: {
          type: "booking:quote_counter",
          bookingId: booking._id,
          bookingCode: booking.bookingCode,
          status: booking.status,
          quoteStatus: booking.quoteStatus
        },
        smsBody: `ApnaServo: Customer sent counter offer Rs ${booking.quoteCounterAmount} for booking ${booking.bookingCode}.`
      });
    }

    return res.json({ booking: serializeBooking(booking), fraudWarning: fraudScan.flagged });
  } catch (error) {
    return next(error);
  }
}

async function monitorBookingChat(req, res, next) {
  try {
    const body = chatMonitorSchema.parse(req.body || {});
    const booking = await Booking.findOne(bookingIdFilter(String(req.params.bookingId || "")));
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    let actorRole = "";
    if (partner && String(booking.partnerId || "") === String(partner._id)) {
      actorRole = "partner";
    } else if (user && String(booking.userId || "") === String(user._id)) {
      actorRole = "user";
    } else {
      return res.status(403).json({ message: "Not allowed to monitor this booking chat" });
    }

    const fraudScan = await recordFraudSignal({
      booking,
      partnerId: booking.partnerId,
      userId: booking.userId,
      actorRole,
      source: body.source || "booking_chat",
      message: body.message,
      metadata: { clientMessageId: body.clientMessageId || "" }
    });

    return res.json({
      ok: true,
      flagged: fraudScan.flagged,
      severity: fraudScan.severity,
      matchedTerms: fraudScan.matchedTerms || []
    });
  } catch (error) {
    return next(error);
  }
}

async function reportCustomerNoResponse(req, res, next) {
  try {
    const body = noResponseReportSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      partnerId: partner._id,
      status: { $in: ["on_the_way", "arrived", "started"] }
    });
    if (!booking) {
      return res.status(404).json({ message: "Active assigned booking not found" });
    }

    const validation = validatePartnerLocation({
      partner,
      booking,
      payload: {
        ...body,
        accuracy: body.accuracy || 9999,
        provider: body.provider || "unknown",
        recordedAt: body.recordedAt || Date.now()
      },
      requireNearCustomer: true
    });
    await LocationLog.create({
      partnerId: partner._id,
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      lat: Number.isFinite(validation.lat) ? validation.lat : 0,
      lng: Number.isFinite(validation.lng) ? validation.lng : 0,
      accuracy: validation.accuracy,
      provider: validation.provider,
      isMock: validation.isMock,
      validationStatus: validation.valid ? "accepted" : "rejected",
      reason: validation.reason,
      speedMps: validation.speedMps,
      distanceToCustomerM: validation.distanceToCustomerM,
      recordedAt: validation.recordedAt
    });
    if (!validation.valid) {
      await Partner.findByIdAndUpdate(partner._id, { $set: { locationTrustStatus: "suspicious" } });
      return res.status(422).json({ message: validation.reason });
    }

    const report = await CustomerNoResponseReport.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      partnerId: partner._id,
      userId: booking.userId,
      reason: body.reason,
      evidenceUrl: body.evidenceUrl || "",
      lat: validation.lat,
      lng: validation.lng,
      accuracy: validation.accuracy,
      provider: validation.provider,
      reportedAt: new Date()
    });

    booking.status = "customer_no_response";
    booking.noResponseReport = {
      reported: true,
      reportedAt: report.reportedAt,
      reason: body.reason,
      lat: validation.lat,
      lng: validation.lng,
      accuracy: validation.accuracy,
      evidenceUrl: body.evidenceUrl || ""
    };
    booking.statusTimeline.push({ status: "customer_no_response", at: new Date(), by: "partner" });
    await booking.save();
    await User.findByIdAndUpdate(booking.userId, {
      $inc: { fakeBookingWarningCount: 1 },
      $set: { bookingRiskStatus: "review" }
    });
    await Partner.findByIdAndUpdate(partner._id, { $set: partnerLocationUpdate(validation) });

    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:customer_no_response", {
      ...serializeBooking(booking),
      reportId: String(report._id),
      reason: report.reason
    });

    const userForNotification = await User.findById(booking.userId);
    await reliableNotify({
      recipients: [userRecipient(userForNotification)],
      title: "Customer Unavailable Reported",
      body: "Partner reported no response at your service address. Support may contact you.",
      category: "booking_status",
      priority: "high",
      data: {
        type: "booking:customer_no_response",
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        status: booking.status
      },
      smsBody: `ApnaServo: Partner reported no response for booking ${booking.bookingCode}. Support may contact you.`
    });

    return res.json({ ok: true, reportId: report._id, booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function getBooking(req, res, next) {
  try {
    const bookingId = String(req.params.bookingId || "");
    const query = bookingIdFilter(bookingId);
    const booking = await Booking.findOne(query);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    await expireQuoteIfNeeded(booking, { emit: true });
    const [partner, user] = await Promise.all([
      Partner.findOne({ firebaseUid: req.auth.uid }),
      User.findOne({ firebaseUid: req.auth.uid })
    ]);
    if (user && String(booking.userId || "") === String(user._id)) {
      return res.json({ booking: serializeBooking(booking) });
    }
    if (partner) {
      const isAssignedPartner = String(booking.partnerId || "") === String(partner._id);
      const isRequestedPartner = (booking.requestedPartners || []).some((partnerId) => String(partnerId) === String(partner._id));
      const canViewOpenJobs = partnerCanViewOpenJobs(partner);
      const canSeeOpenRequest = !booking.partnerId
        && pendingAssignmentStatuses().includes(booking.status)
        && canViewOpenJobs
        && isRequestedPartner
        && !booking.rejectedPartners?.some((partnerId) => String(partnerId) === String(partner._id));
      if (!isAssignedPartner && !canSeeOpenRequest) {
        return res.status(403).json({ message: "Not allowed to access this booking" });
      }
      return res.json({ booking: protectCustomerPhoneForPartner(serializeBooking(booking), booking, partner) });
    }
    return res.status(403).json({ message: "Not allowed to access this booking" });
  } catch (error) {
    return next(error);
  }
}

async function createCallLog(req, res, next) {
  try {
    const body = callActionSchema.parse(req.body || {});
    const [partner, user] = await Promise.all([
      Partner.findOne({ firebaseUid: req.auth.uid }),
      User.findOne({ firebaseUid: req.auth.uid })
    ]);

    const booking = await Booking.findOne(bookingIdFilter(String(req.params.bookingId || "")));
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const isPartner = partner && String(booking.partnerId || "") === String(partner._id);
    const isUser = user && String(booking.userId || "") === String(user._id);
    if (!isPartner && !isUser) {
      return res.status(403).json({ message: "Only booking participants can start this call" });
    }
    if (!booking.partnerId) {
      return res.status(409).json({ message: "Partner is not assigned yet" });
    }

    const [assignedPartner, bookingUser] = await Promise.all([
      booking.partnerId ? Partner.findById(booking.partnerId) : null,
      booking.userId ? User.findById(booking.userId) : null
    ]);
    const configuredVirtualNumber = virtualCallNumber();
    const directNumber = isPartner
      ? (booking.userSnapshot?.phone || bookingUser?.phone || "")
      : (booking.partnerSnapshot?.phone || assignedPartner?.phone || "");
    const virtualNumber = isPartner && configuredVirtualNumber ? configuredVirtualNumber : "";
    const phoneNumber = virtualNumber || String(directNumber || "");
    const status = body.action === "report"
      ? "reported"
      : virtualNumber
        ? "virtual_call_ready"
        : phoneNumber
          ? "direct_call_ready"
          : "virtual_call_unconfigured";

    const log = await CallLog.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      partnerId: booking.partnerId,
      userId: booking.userId,
      action: body.action,
      direction: isPartner ? "partner_to_customer" : "user_to_partner",
      status,
      customerPhoneMasked: maskPhone(directNumber),
      virtualNumber: body.action === "start" ? virtualNumber : "",
      reason: body.reason || "",
      userAgent: req.get("user-agent") || "",
      ip: req.ip || ""
    });

    const fraudScan = await recordFraudSignal({
      booking,
      partnerId: booking.partnerId,
      userId: booking.userId,
      actorRole: isPartner ? "partner" : "user",
      source: body.action === "report" ? "call_report" : "call_start",
      message: body.reason || "",
      metadata: { callLogId: log._id, action: body.action }
    });
    emitAdminEvent("booking:call_log", {
      ...serializeBooking(booking),
      callLogId: String(log._id),
      action: body.action,
      status,
      actorRole: isPartner ? "partner" : "user",
      partnerId: String(booking.partnerId),
      partnerName: booking.partnerSnapshot?.name || partner?.name || ""
    });

    return res.json({
      ok: true,
      callLogId: log._id,
      maskedCustomerPhone: log.customerPhoneMasked,
      virtualNumber: body.action === "start" ? virtualNumber : "",
      phoneNumber: body.action === "start" ? phoneNumber : "",
      canCall: body.action === "start" && Boolean(phoneNumber),
      status,
      fraudWarning: fraudScan.flagged
    });
  } catch (error) {
    return next(error);
  }
}

async function submitDirectPayment(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "Customer profile not found" });
    }
    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      userId: user._id
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status !== "amount_pending") {
      return res.status(409).json({ message: "Payment can be submitted only after partner sends the final amount" });
    }
    const quoteStatus = approvalQuoteStatus(booking);
    if (quoteStatus === "payment_submitted") {
      return res.json({ booking: serializeBooking(booking), idempotent: true });
    }
    if (quoteStatus !== "pending") {
      return res.status(409).json({ message: "Quote is not ready for payment" });
    }
    if (booking.quoteExpiresAt && new Date(booking.quoteExpiresAt).getTime() <= Date.now()) {
      return res.status(410).json({ message: "Quote expired. Ask partner to send a fresh quote." });
    }

    const now = new Date();
    booking.quoteStatus = "payment_submitted";
    booking.paymentSubmittedAt = now;
    booking.paymentStatus = "pending";
    booking.statusTimeline.push({ status: "payment_submitted", at: now, by: "user" });
    booking.quoteHistory.push({
      kind: "payment_submitted",
      amount: Number(booking.finalAmount || booking.quoteAmount || booking.price || 0),
      by: "user",
      message: "Customer marked direct payment as paid to partner",
      at: now
    });
    await booking.save();

    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:payment_submitted", serializeBooking(booking));

    const partnerForNotification = booking.partnerId ? await Partner.findById(booking.partnerId) : null;
    await reliableNotify({
      recipients: [partnerRecipient(partnerForNotification)].filter(Boolean),
      title: "Payment Submitted",
      body: `Customer marked Rs ${booking.finalAmount || booking.quoteAmount || booking.price || 0} as paid for booking ${booking.bookingCode}. Verify after receiving it.`,
      category: "payment",
      priority: "high",
      data: { type: "booking:payment_submitted", status: "amount_pending", bookingId: booking._id, bookingCode: booking.bookingCode },
      smsBody: `ApnaServo: Customer marked payment as paid for booking ${booking.bookingCode}. Verify after receiving it.`
    });

    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function getTracking(req, res, next) {
  try {
    const booking = await Booking.findOne(bookingIdFilter(String(req.params.bookingId || "")));
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const [partner, user] = await Promise.all([
      Partner.findOne({ firebaseUid: req.auth.uid }),
      User.findOne({ firebaseUid: req.auth.uid })
    ]);
    const isAssignedPartner = partner && String(booking.partnerId || "") === String(partner._id);
    const isBookingUser = user && String(booking.userId || "") === String(user._id);
    if (!isAssignedPartner && !isBookingUser) {
      return res.status(403).json({ message: "Not allowed to track this booking" });
    }

    const bookingPartner = booking.partnerId ? await Partner.findById(booking.partnerId) : null;
    const recentLocations = booking.partnerId
      ? await LocationLog.find({ bookingId: booking._id, partnerId: booking.partnerId, validationStatus: "accepted" })
        .sort({ recordedAt: -1 })
        .limit(20)
      : [];
    const latestLocation = recentLocations[0] || null;
    return res.json({
      tracking: serializeTracking({
        booking,
        partner: bookingPartner,
        latestLocation,
        recentLocations
      })
    });
  } catch (error) {
    return next(error);
  }
}

async function createTechnicianSos(req, res, next) {
  try {
    const body = sosSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      partnerId: partner._id,
      status: { $in: ["accepted", "on_the_way", "arrived", "started", "amount_pending"] }
    });
    if (!booking) {
      return res.status(404).json({ message: "Active assigned booking not found" });
    }

    const sos = await TechnicianSos.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      partnerId: partner._id,
      userId: booking.userId,
      reason: body.reason || "emergency",
      note: body.note || "",
      lat: Number.isFinite(body.lat) ? body.lat : 0,
      lng: Number.isFinite(body.lng) ? body.lng : 0,
      accuracy: Number.isFinite(body.accuracy) ? body.accuracy : 9999
    });

    booking.latestSosId = sos._id;
    booking.statusTimeline.push({ status: "technician_sos", at: new Date(), by: "partner" });
    await booking.save();

    const user = await User.findById(booking.userId);
    await reliableNotify({
      recipients: [userRecipient(user)],
      title: "Technician SOS Alert",
      body: `${partner.name} raised an SOS for booking ${booking.bookingCode}. Support has been alerted.`,
      category: "technician_sos",
      priority: "high",
      data: {
        type: "booking:technician_sos",
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        sosId: sos._id,
        reason: sos.reason
      },
      smsBody: `ApnaServo SOS: Technician raised emergency alert for booking ${booking.bookingCode}.`
    });

    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:technician_sos", {
      ...serializeBooking(booking),
      sosId: String(sos._id),
      reason: sos.reason
    });
    return res.status(201).json({
      ok: true,
      sos: {
        id: String(sos._id),
        bookingId: String(sos.bookingId),
        bookingCode: sos.bookingCode,
        reason: sos.reason,
        status: sos.status,
        createdAt: sos.createdAt ? sos.createdAt.toISOString() : ""
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadJobProofPhoto(req, res, next) {
  try {
    const body = proofPhotoSchema.parse(req.body || {});
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "Proof photo is required" });
    }

    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      partnerId: partner._id,
      status: { $in: ["accepted", "on_the_way", "arrived", "started", "amount_pending", "completed"] }
    });
    if (!booking) {
      return res.status(404).json({ message: "Assigned booking not found" });
    }

    const uploaded = await uploadProofToCloudinary(file, booking._id, body.stage);
    const photo = await JobProofPhoto.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      partnerId: partner._id,
      userId: booking.userId,
      stage: body.stage,
      ...uploaded,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      note: body.note || "",
      lat: Number.isFinite(body.lat) ? body.lat : 0,
      lng: Number.isFinite(body.lng) ? body.lng : 0,
      accuracy: Number.isFinite(body.accuracy) ? body.accuracy : 9999
    });

    const incField = body.stage === "before" ? "proofSummary.beforeCount" : "proofSummary.afterCount";
    await Booking.findByIdAndUpdate(booking._id, {
      $inc: { [incField]: 1 },
      $set: { "proofSummary.lastUploadedAt": new Date() },
      $push: { statusTimeline: { status: `proof_${body.stage}_uploaded`, at: new Date(), by: "partner" } }
    });

    const user = await User.findById(booking.userId);
    await reliableNotify({
      recipients: [userRecipient(user)],
      title: body.stage === "before" ? "Before Work Photo Added" : "After Work Photo Added",
      body: `${partner.name} uploaded ${body.stage} work proof for booking ${booking.bookingCode}.`,
      category: "job_proof",
      priority: "normal",
      data: {
        type: "booking:proof_photo",
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        stage: body.stage,
        proofPhotoId: photo._id
      }
    });
    emitAdminEvent("booking:proof_photo_uploaded", {
      ...serializeBooking(booking),
      proofPhotoId: String(photo._id),
      stage: body.stage,
      actorRole: "partner",
      partnerId: String(partner._id),
      partnerName: partner.name || ""
    });

    return res.status(201).json({ ok: true, proofPhoto: serializeProofPhoto(photo) });
  } catch (error) {
    return next(error);
  }
}

async function createRevisitRequest(req, res, next) {
  try {
    const body = revisitRequestSchema.parse(req.body || {});
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "Customer profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(String(req.params.bookingId || "")),
      userId: user._id,
      status: "completed"
    });
    if (!booking) {
      return res.status(404).json({ message: "Completed booking not found" });
    }

    const warrantyEnd = booking.warranty?.warrantyEndDate ? new Date(booking.warranty.warrantyEndDate) : null;
    if (!booking.warranty?.eligible || !warrantyEnd || warrantyEnd.getTime() < Date.now()) {
      return res.status(409).json({ message: "Warranty period is over for this booking" });
    }

    const existingOpen = await RevisitRequest.findOne({
      bookingId: booking._id,
      status: { $in: ["open", "partner_notified", "scheduled"] }
    });
    if (existingOpen) {
      return res.status(200).json({ revisitRequest: serializeRevisitRequest(existingOpen), idempotent: true });
    }

    const request = await RevisitRequest.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      userId: user._id,
      partnerId: booking.partnerId,
      reason: body.reason || "same_issue_again",
      message: body.message || "Same issue again",
      warrantyEndDate: warrantyEnd,
      status: "partner_notified"
    });

    booking.warranty.revisitRequested = true;
    booking.warranty.revisitRequestId = request._id;
    booking.statusTimeline.push({ status: "revisit_requested", at: new Date(), by: "user" });
    await booking.save();

    const partner = booking.partnerId ? await Partner.findById(booking.partnerId) : null;
    await reliableNotify({
      recipients: [partnerRecipient(partner)].filter(Boolean),
      title: "Revisit Request",
      body: `Customer reported the same issue again for booking ${booking.bookingCode}.`,
      category: "revisit_request",
      priority: "high",
      data: {
        type: "booking:revisit_request",
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        revisitRequestId: request._id
      },
      smsBody: `ApnaServo: Revisit requested for booking ${booking.bookingCode}. Customer says same issue again.`
    });

    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:revisit_requested", {
      ...serializeBooking(booking),
      revisitRequestId: String(request._id),
      reason: request.reason
    });
    return res.status(201).json({ revisitRequest: serializeRevisitRequest(request) });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBooking,
  listUserBookings,
  listPartnerBookings,
  acceptBooking,
  rejectBooking,
  updateStatus,
  getTracking,
  createTechnicianSos,
  uploadJobProofPhoto,
  createRevisitRequest,
  counterOfferQuote,
  submitDirectPayment,
  monitorBookingChat,
  reportCustomerNoResponse,
  getBooking,
  createCallLog
};
