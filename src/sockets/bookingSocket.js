const { admin } = require("../config/firebase");
const crypto = require("crypto");
const { allowedCorsOrigins } = require("../config/env");
const User = require("../models/User");
const Partner = require("../models/Partner");
const Booking = require("../models/Booking");
const LocationLog = require("../models/LocationLog");
const AdminActivity = require("../models/AdminActivity");
const { validatePartnerLocation, partnerLocationUpdate } = require("../utils/locationValidation");
const { lifecycleLabel, lifecycleStatusForBooking } = require("../utils/bookingLifecycle");

let io;

function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return "Protected";
  const last = digits.slice(-4);
  const prefix = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
  return `${prefix}******${last}`;
}

function virtualCallingEnabled() {
  return Boolean(String(process.env.VIRTUAL_CALL_NUMBER || process.env.APNA_SERVO_VIRTUAL_CALL_NUMBER || "").trim());
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

function isEmptyIdentityPartner(partner) {
  return Boolean(partner && !partner.phoneHash && !partner.emailHash);
}

function millis(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function quoteExpired(doc) {
  const expiresAt = millis(doc.quoteExpiresAt);
  return (doc.quoteStatus || "") === "pending" && expiresAt > 0 && expiresAt <= Date.now();
}

function allowSocketEvent(socket, key, limit, windowMs) {
  const now = Date.now();
  socket.rateLimits = socket.rateLimits || {};
  const bucket = socket.rateLimits[key] || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  socket.rateLimits[key] = bucket;
  return bucket.count <= limit;
}

function handleSocketEvent(socket, event, handler) {
  socket.on(event, (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error(`Socket event ${event} failed:`, error);
      socket.emit("realtime:error", {
        event,
        message: "Realtime update failed. The app will retry automatically."
      });
    });
  });
}

function verifyAdminRealtimeToken(token) {
  const secret = String(process.env.ADMIN_API_SECRET || "").trim();
  const value = String(token || "").trim();
  if (!secret || !value.includes(".")) {
    return false;
  }
  const [expiresAtRaw, signature] = value.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(String(expiresAtRaw)).digest("hex");
  const left = Buffer.from(signature || "");
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function serializeBooking(booking) {
  const doc = typeof booking.toObject === "function" ? booking.toObject() : booking;
  const location = doc.location || { coordinates: [0, 0] };
  const rawQuoteStatus = doc.quoteStatus || "";
  const quoteStatus = rawQuoteStatus && rawQuoteStatus !== "none"
    ? rawQuoteStatus
    : (doc.status === "amount_pending" ? "pending" : "none");
  const quoteAmount = Number(doc.quoteAmount || doc.finalAmount || 0);
  const lifecycleStatus = lifecycleStatusForBooking(doc);
  return {
    _id: String(doc._id),
    bookingId: String(doc._id),
    bookingCode: doc.bookingCode,
    userId: doc.userId ? String(doc.userId) : "",
    partnerId: doc.partnerId ? String(doc.partnerId) : "",
    serviceCategory: doc.serviceCategory,
    serviceName: doc.serviceName,
    issue: doc.issue,
    address: doc.address,
    city: doc.city,
    lat: location.coordinates ? location.coordinates[1] : 0,
    lng: location.coordinates ? location.coordinates[0] : 0,
    status: doc.status,
    legacyStatus: doc.status,
    lifecycleStatus,
    lifecycleLabel: lifecycleLabel(lifecycleStatus),
    emergency: doc.emergency || {},
    isEmergency: Boolean(doc.emergency?.isEmergency),
    emergencyType: doc.emergency?.type || "none",
    emergencyPriority: doc.emergency?.priority || "normal",
    price: doc.price,
    finalAmount: doc.finalAmount || 0,
    paymentStatus: doc.paymentStatus,
    customerVerification: doc.customerVerification || {},
    customerPhoneVerified: Boolean(doc.customerVerification?.phoneVerified),
    customerOtpRequired: Boolean(doc.customerVerification?.otpRequired),
    amountRequestedAt: doc.amountRequestedAt,
    amountRequestedAtMillis: millis(doc.amountRequestedAt),
    quoteAmount,
    quoteStatus,
    quoteRequestedAt: doc.quoteRequestedAt || doc.amountRequestedAt || null,
    quoteRequestedAtMillis: millis(doc.quoteRequestedAt || doc.amountRequestedAt),
    quoteExpiresAt: doc.quoteExpiresAt || null,
    quoteExpiresAtMillis: millis(doc.quoteExpiresAt),
    quoteApprovedAt: doc.quoteApprovedAt || null,
    quoteApprovedAtMillis: millis(doc.quoteApprovedAt),
    quoteExpired: quoteExpired({ ...doc, quoteStatus }),
    quoteCounterAmount: doc.quoteCounterAmount || 0,
    quoteCounterMessage: doc.quoteCounterMessage || "",
    quoteCounterAt: doc.quoteCounterAt || null,
    quoteCounterAtMillis: millis(doc.quoteCounterAt),
    noResponseReport: doc.noResponseReport || {},
    noResponseReported: Boolean(doc.noResponseReport?.reported),
    noResponseReportedAtMillis: millis(doc.noResponseReport?.reportedAt),
    warranty: doc.warranty || {},
    warrantyEligible: Boolean(doc.warranty?.eligible),
    warrantyEndDate: doc.warranty?.warrantyEndDate || null,
    warrantyEndDateMillis: millis(doc.warranty?.warrantyEndDate),
    revisitRequested: Boolean(doc.warranty?.revisitRequested),
    proofSummary: doc.proofSummary || {},
    slot: doc.slot,
    partnerArrivalEstimateMinutes: doc.partnerArrivalEstimateMinutes || 0,
    partnerArrivalEstimateLabel: doc.partnerArrivalEstimateLabel || "",
    expectedArrivalAt: doc.expectedArrivalAt || null,
    expectedArrivalAtMillis: millis(doc.expectedArrivalAt),
    userName: doc.userSnapshot?.name || "",
    userPhone: doc.userSnapshot?.phone || "",
    partnerName: doc.partnerSnapshot?.name || "",
    partnerPhone: doc.partnerSnapshot?.phone || "",
    partnerPhoto: doc.partnerSnapshot?.photoUrl || "",
    partnerPhotoUrl: doc.partnerSnapshot?.photoUrl || "",
    createdAt: doc.createdAt,
    createdAtMillis: millis(doc.createdAt),
    acceptedAt: doc.acceptedAt,
    acceptedAtMillis: millis(doc.acceptedAt),
    completedAt: doc.completedAt,
    completedAtMillis: millis(doc.completedAt)
  };
}

function partnerBookingPayload(booking) {
  const payload = serializeBooking(booking);
  const doc = typeof booking.toObject === "function" ? booking.toObject() : booking;
  const assignedPartnerId = doc.partnerId || payload.partnerId || payload.assignedPartnerId || "";
  const realCustomerPhone = assignedPartnerId
    ? String(doc.userSnapshot?.phone || payload.userPhone || payload.customerPhone || "")
    : "";
  const protectedPhone = maskPhone(doc.userSnapshot?.phone || payload.userPhone || payload.customerPhone);
  return {
    ...payload,
    userPhone: realCustomerPhone || protectedPhone,
    customerPhone: realCustomerPhone,
    customerPhoneMasked: realCustomerPhone || protectedPhone,
    phoneProtected: !realCustomerPhone,
    virtualCalling: virtualCallingEnabled()
  };
}

function livePartnerLocationPayload(booking, partner, validation) {
  const updatedAtMillis = millis(validation.recordedAt) || Date.now();
  return {
    ...serializeBooking(booking),
    partnerLat: validation.lat,
    partnerLng: validation.lng,
    partnerLocationAtMillis: updatedAtMillis,
    partnerLocation: {
      lat: validation.lat,
      lng: validation.lng,
      accuracy: validation.accuracy,
      provider: validation.provider,
      trustStatus: partner?.locationTrustStatus || "trusted",
      updatedAtMillis
    }
  };
}

function bookingIdentityClauses(value) {
  const id = String(value || "").trim();
  if (!id) return [];
  const clauses = [{ bookingCode: id }];
  if (/^[0-9a-fA-F]{24}$/.test(id)) {
    clauses.push({ _id: id });
  }
  return clauses;
}

async function identifySocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace("Bearer ", "");
    const role = socket.handshake.auth?.role || socket.handshake.query?.role || "";
    const devUid = String(socket.handshake.auth?.devUid || "").trim();

    if (role === "admin") {
      const adminToken = socket.handshake.auth?.adminToken || socket.handshake.query?.adminToken || "";
      if (!verifyAdminRealtimeToken(adminToken)) {
        return next(new Error("Admin realtime token invalid"));
      }
      socket.auth = { uid: "admin-dashboard", email: "admin-dashboard@apnaservo.internal" };
      socket.role = "admin";
      socket.join("admin");
      return next();
    }

    let decoded;
    const developmentDeviceAuth = process.env.DISABLE_DEVICE_AUTH_FALLBACK !== "true"
      && ["user", "partner"].includes(role)
      && devUid.startsWith(`local-${role}-`)
      && /^(local-user|local-partner)-[a-zA-Z0-9._:-]{6,160}$/.test(devUid);

    if (developmentDeviceAuth) {
      decoded = {
        uid: devUid,
        role,
        email_verified: false,
        development_device: true
      };
    } else {
      if (!token) {
        return next(new Error("Firebase token missing"));
      }
      decoded = await admin.auth().verifyIdToken(token, process.env.NODE_ENV === "production");
    }
    socket.auth = decoded;
    socket.role = role;

    if (role === "partner") {
      let partner = await Partner.findOne({ firebaseUid: decoded.uid });
      if ((!partner || isEmptyIdentityPartner(partner)) && decoded.email_verified === true && decoded.email) {
        const emailHash = identityHash(normalizeEmail(decoded.email));
        if (emailHash) {
          const emailPartner = await Partner.findOne({ emailHash, firebaseUid: { $ne: decoded.uid } });
          if (emailPartner) {
            if (partner && !emailPartner.fcmToken && partner.fcmToken) {
              emailPartner.fcmToken = partner.fcmToken;
            }
            if (partner && String(partner._id) !== String(emailPartner._id)) {
              await Partner.deleteOne({ _id: partner._id });
            }
            emailPartner.firebaseUid = decoded.uid;
            await emailPartner.save();
            partner = emailPartner;
          }
        }
      }
      if (partner) {
        socket.partner = partner;
        socket.join(`partner:${partner._id}`);
      } else {
        socket.emit("realtime:identity_missing", { role: "partner" });
      }
    } else {
      const user = await User.findOneAndUpdate(
        { firebaseUid: decoded.uid },
        {
          $setOnInsert: {
            firebaseUid: decoded.uid,
            name: decoded.name || "ApnaServo Customer",
            phone: decoded.phone_number || "",
            email: normalizeEmail(decoded.email || "")
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (user) {
        socket.user = user;
        socket.join(`user:${user._id}`);
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function initBookingSocket(httpServer) {
  io = require("socket.io")(httpServer, {
    cors: {
      origin: allowedCorsOrigins().includes("*") && process.env.NODE_ENV !== "production"
        ? "*"
        : allowedCorsOrigins(),
      methods: ["GET", "POST", "PATCH"]
    },
    transports: ["websocket", "polling"],
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 45000
  });

  io.use(identifySocket);

  io.on("connection", (socket) => {
    handleSocketEvent(socket, "partner:online", async (payload = {}) => {
      if (!socket.partner) return;
      if (!allowSocketEvent(socket, "partner:online", 20, 60 * 1000)) {
        socket.emit("rate_limited", { event: "partner:online" });
        return;
      }
      const partner = await Partner.findById(socket.partner._id);
      if (!partner) return;
      const update = { isOnline: true };
      if (payload.lat && payload.lng && payload.accuracy) {
        const validation = validatePartnerLocation({ partner, payload });
        if (validation.valid) {
          Object.assign(update, partnerLocationUpdate(validation));
        }
      }
      socket.partner = await Partner.findByIdAndUpdate(partner._id, { $set: update }, { new: true });
      socket.join(`partner:${partner._id}`);
      socket.emit("partner:online", { ok: true });
    });

    handleSocketEvent(socket, "partner:offline", async () => {
      if (!socket.partner) return;
      if (!allowSocketEvent(socket, "partner:offline", 20, 60 * 1000)) {
        socket.emit("rate_limited", { event: "partner:offline" });
        return;
      }
      socket.partner = await Partner.findByIdAndUpdate(
        socket.partner._id,
        { $set: { isOnline: false } },
        { new: true }
      );
      socket.emit("partner:offline", { ok: true });
    });

    handleSocketEvent(socket, "partner:location_update", async (payload = {}) => {
      if (!socket.partner) return;
      if (!allowSocketEvent(socket, "partner:location_update", 90, 60 * 1000)) {
        socket.emit("rate_limited", { event: "partner:location_update" });
        return;
      }
      const partner = await Partner.findById(socket.partner._id);
      if (!partner) return;
      const validation = validatePartnerLocation({ partner, payload });
      await LocationLog.create({
        partnerId: partner._id,
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
        socket.emit("partner:location_rejected", { message: validation.reason });
        return;
      }
      socket.partner = await Partner.findByIdAndUpdate(
        partner._id,
        { $set: partnerLocationUpdate(validation) },
        { new: true }
      );
      socket.emit("partner:location_ok", { ok: true });
      const activeStatuses = ["accepted", "on_the_way", "arrived", "started", "amount_pending"];
      const query = { partnerId: partner._id, status: { $in: activeStatuses } };
      const clauses = bookingIdentityClauses(payload.bookingId);
      if (clauses.length) {
        query.$or = clauses;
      }
      const activeBooking = await Booking.findOne(query).sort({ updatedAt: -1 });
      if (activeBooking) {
        const locationPayload = livePartnerLocationPayload(activeBooking, socket.partner, validation);
        emitAdminEvent("partner:location_update", locationPayload);
        io.to(`user:${activeBooking.userId}`).emit("partner:location_update", locationPayload);
        io.to(`partner:${partner._id}`).emit("partner:location_update", locationPayload);
      }
    });
  });

  return io;
}

function emitNewBookingToPartners(booking, partners) {
  if (!io) return;
  const payload = partnerBookingPayload(booking);
  const targetPartners = Array.isArray(partners) ? partners : [];
  for (const partner of targetPartners) {
    io.to(`partner:${partner._id}`).emit("booking:new_request", payload);
  }
}

function emitBookingAccepted(booking, acceptedPartner = null) {
  const userPayload = serializeBooking(booking);
  const partnerPayload = partnerBookingPayload(booking);
  const winnerPartnerId = booking.partnerId ? String(booking.partnerId) : "";
  const winnerFirebaseUid = acceptedPartner?.firebaseUid || "";
  emitAdminEvent("booking:accepted", userPayload);
  if (!io) return;
  const unavailablePayload = {
    _id: String(booking._id),
    bookingId: String(booking._id),
    bookingCode: booking.bookingCode || "",
    serviceCategory: booking.serviceCategory || "",
    city: booking.city || "",
    status: "accepted",
    removeFromQueue: true,
    unavailableReason: "accepted_by_other_partner",
    acceptedByPartnerId: winnerPartnerId,
    acceptedByFirebaseUid: winnerFirebaseUid,
    updatedAtMillis: Date.now()
  };
  io.to(`user:${booking.userId}`).emit("booking:accepted", userPayload);
  if (winnerPartnerId) {
    io.to(`partner:${winnerPartnerId}`).emit("booking:accepted", partnerPayload);
  }
  for (const partnerId of booking.requestedPartners || []) {
    const targetPartnerId = String(partnerId);
    if (targetPartnerId === winnerPartnerId) {
      continue;
    }
    io.to(`partner:${targetPartnerId}`).emit("booking:unavailable", unavailablePayload);
  }
}

function emitBookingRejected(booking, partnerId) {
  emitAdminEvent("booking:rejected", {
    ...serializeBooking(booking),
    rejectedByPartnerId: String(partnerId || "")
  });
  if (!io) return;
  io.to(`partner:${partnerId}`).emit("booking:rejected", partnerBookingPayload(booking));
}

function emitBookingStatusUpdate(booking) {
  const userPayload = serializeBooking(booking);
  const partnerPayload = partnerBookingPayload(booking);
  emitAdminEvent("booking:status_update", userPayload);
  if (!io) return;
  io.to(`user:${booking.userId}`).emit("booking:status_update", userPayload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:status_update", partnerPayload);
  }
}

function emitBookingChatMessage(booking, message) {
  if (!io || !booking || !message) return;
  const payload = {
    ...message,
    bookingId: String(booking._id),
    bookingCode: booking.bookingCode || message.bookingCode || ""
  };
  io.to(`user:${booking.userId}`).emit("booking:chat_message", payload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:chat_message", payload);
  }
}

function emitBookingChatSeen(booking, payload) {
  if (!io || !booking || !payload) return;
  io.to(`user:${booking.userId}`).emit("booking:chat_seen", payload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:chat_seen", payload);
  }
}

function mongoId(value) {
  const text = String(value || "").trim();
  return /^[a-f0-9]{24}$/i.test(text) ? text : null;
}

function eventCategory(eventName) {
  return String(eventName || "").split(":")[0] || "system";
}

function eventTitle(eventName, payload) {
  const status = String(payload.status || "").toLowerCase();
  const quoteStatus = String(payload.quoteStatus || "").toLowerCase();
  const titles = {
    "user:registered": "New user registered",
    "user:updated": "User account updated",
    "booking:new_request": "New booking created",
    "booking:accepted": "Partner assigned",
    "booking:rejected": "Partner rejected booking",
    "booking:quote_sent": "Partner sent final amount",
    "booking:quote_countered": "Customer sent counter offer",
    "booking:quote_expired": "Final amount approval expired",
    "booking:payment_accepted": "Customer accepted amount",
    "booking:completed": "Booking completed",
    "booking:cancelled": "Booking cancelled",
    "booking:disputed": "Booking disputed",
    "booking:customer_no_response": "Customer no-response reported",
    "booking:technician_sos": "Technician SOS raised",
    "booking:proof_photo_uploaded": "Job proof photo uploaded",
    "booking:revisit_requested": "Warranty revisit requested",
    "booking:call_log": "Partner call activity",
    "payment:created": "Payment order created",
    "payment:confirmed": "Payment confirmed",
    "complaint:submitted": "New complaint submitted",
    "complaint:updated": "Complaint updated",
    "support:ticket_created": "New support ticket",
    "support:ticket_updated": "Support ticket updated",
    "partner:registered": "New partner registered",
    "partner:updated": "Partner profile updated",
    "partner:online": "Partner came online",
    "partner:offline": "Partner went offline",
    "partner:location_update": "Partner location updated"
  };
  if (eventName === "booking:status_update") {
    if (status === "sent_to_partner") return "Booking sent to partners";
    if (status === "accepted") return "Partner assigned";
    if (status === "on_the_way") return "Partner on the way";
    if (status === "arrived") return "Partner arrived";
    if (status === "started") return "Job started";
    if (status === "amount_pending" && quoteStatus === "countered") return "Customer sent counter offer";
    if (status === "amount_pending") return "Partner sent final amount";
    if (status === "completed") return "Booking completed";
    if (status === "cancelled" || status === "canceled") return "Booking cancelled";
    if (status === "disputed") return "Booking disputed";
    if (status === "customer_no_response") return "Customer no-response reported";
  }
  return titles[eventName] || String(eventName || "Admin activity").replace(/[:_]/g, " ");
}

function eventDetail(eventName, payload) {
  const bookingCode = payload.bookingCode || payload.bookingId || "";
  const userName = payload.userName || payload.name || "";
  const partnerName = payload.partnerName || "";
  const amount = Number(payload.finalAmount || payload.quoteAmount || payload.amount || 0);
  const status = payload.status ? String(payload.status).replace(/_/g, " ") : "";
  if (eventName.startsWith("booking:")) {
    const parts = [
      bookingCode ? `Booking ${bookingCode}` : "Booking",
      payload.serviceName || payload.serviceCategory || "",
      userName ? `Customer ${userName}` : "",
      partnerName ? `Partner ${partnerName}` : "",
      amount ? `Rs ${amount}` : "",
      status ? `Status ${status}` : ""
    ].filter(Boolean);
    return parts.join(" - ");
  }
  if (eventName.startsWith("payment:")) {
    return [
      bookingCode ? `Booking ${bookingCode}` : "Payment",
      amount ? `Rs ${amount}` : "",
      payload.paymentStatus || payload.status || ""
    ].filter(Boolean).join(" - ");
  }
  if (eventName.startsWith("support:")) {
    return [
      payload.ticketId || payload.supportTicketId || "Support ticket",
      payload.userName || "",
      payload.priority || "",
      payload.status || ""
    ].filter(Boolean).join(" - ");
  }
  if (eventName.startsWith("complaint:")) {
    return [
      payload.complaintId || payload.disputeId || "Complaint",
      bookingCode ? `Booking ${bookingCode}` : "",
      payload.reason || "",
      payload.status || ""
    ].filter(Boolean).join(" - ");
  }
  if (eventName.startsWith("user:")) {
    return [userName || payload.phone || payload.userId || "User", payload.email || ""].filter(Boolean).join(" - ");
  }
  return status || "Live backend event received";
}

async function recordAdminActivity(eventName, payload) {
  const bookingId = mongoId(payload.bookingId || payload._id);
  await AdminActivity.create({
    eventName,
    category: eventCategory(eventName),
    title: eventTitle(eventName, payload),
    detail: eventDetail(eventName, payload),
    bookingId,
    bookingCode: String(payload.bookingCode || "").trim(),
    userId: mongoId(payload.userId),
    partnerId: mongoId(payload.partnerId || payload.acceptedByPartnerId || payload.rejectedByPartnerId),
    ticketId: String(payload.ticketId || payload.supportTicketId || "").trim(),
    complaintId: String(payload.complaintId || payload.disputeId || "").trim(),
    status: String(payload.status || payload.paymentStatus || "").trim(),
    amount: Number(payload.finalAmount || payload.quoteAmount || payload.amount || 0),
    actorRole: String(payload.actorRole || payload.by || "").trim(),
    actorName: String(payload.actorName || payload.userName || payload.partnerName || payload.name || "").trim(),
    source: String(payload.source || "backend").trim(),
    payload
  });
}

function emitAdminEvent(eventName, payload = {}) {
  if (!eventName) return;
  const eventPayload = {
    ...payload,
    eventName,
    emittedAt: new Date().toISOString()
  };
  recordAdminActivity(eventName, eventPayload).catch((error) => {
    console.error("Failed to record admin activity", {
      eventName,
      message: error.message
    });
  });
  if (io) {
    io.to("admin").emit(eventName, eventPayload);
  }
}

function getIO() {
  return io;
}

module.exports = {
  initBookingSocket,
  emitNewBookingToPartners,
  emitBookingAccepted,
  emitBookingRejected,
  emitBookingStatusUpdate,
  emitBookingChatMessage,
  emitBookingChatSeen,
  emitAdminEvent,
  serializeBooking,
  partnerBookingPayload,
  getIO
};
