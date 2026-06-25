const { z } = require("zod");
const User = require("../models/User");
const SupportTicket = require("../models/SupportTicket");
const { Booking } = require("../models/Booking");
const { emitAdminEvent } = require("../sockets/bookingSocket");
const { normalizeDeviceToken, upsertDeviceToken } = require("../utils/notificationTokens");

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(180).optional().or(z.literal("")),
  profilePhotoUrl: z.string().trim().max(1200).optional(),
  address: z.string().trim().max(700).optional(),
  savedAddresses: z.array(z.object({
    label: z.string().trim().max(80).optional(),
    address: z.string().trim().max(700),
    city: z.string().trim().max(80).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    isDefault: z.boolean().optional()
  })).max(20).optional(),
  city: z.string().trim().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  fcmToken: z.string().trim().max(4096).optional(),
  deviceInfo: z.record(z.string(), z.unknown()).optional()
});

const deletionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

const supportTicketSyncSchema = z.object({
  ticketId: z.string().trim().min(3).max(120),
  clientMessageId: z.string().trim().max(160).optional(),
  senderRole: z.enum(["user", "ai", "support", "system"]).default("user"),
  senderName: z.string().trim().max(120).optional(),
  message: z.string().trim().min(1).max(3000),
  category: z.string().trim().max(80).optional(),
  priority: z.enum(["low", "normal", "medium", "high", "urgent"]).optional(),
  bookingId: z.string().trim().max(120).optional(),
  bookingCode: z.string().trim().max(120).optional(),
  aiSummary: z.string().trim().max(3000).optional(),
  attachmentUrl: z.string().trim().max(2000).optional(),
  attachmentName: z.string().trim().max(255).optional(),
  attachmentMimeType: z.string().trim().max(120).optional()
});

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function tokenPhoneVerified(req, phone) {
  const tokenPhone = normalizePhone(req.auth?.phone_number);
  const profilePhone = normalizePhone(phone);
  return tokenPhone.length === 10 && profilePhone.length === 10 && tokenPhone === profilePhone;
}

function supportCategory(message, requested) {
  if (requested) return requested.toLowerCase();
  const text = String(message || "").toLowerCase();
  if (text.includes("payment") || text.includes("refund") || text.includes("bill")) return "payments";
  if (text.includes("booking") || text.includes("cancel") || text.includes("partner")) return "bookings";
  if (text.includes("complaint") || text.includes("behaviour") || text.includes("quality")) return "complaint";
  if (text.includes("login") || text.includes("app") || text.includes("technical")) return "technical";
  return "general";
}

function supportPriority(message, requested) {
  if (requested) return requested;
  const text = String(message || "").toLowerCase();
  if (text.includes("emergency") || text.includes("fraud") || text.includes("unsafe")) return "urgent";
  if (text.includes("complaint") || text.includes("refund") || text.includes("not received")) return "high";
  return "normal";
}

async function resolveBooking(rawId, rawCode, userId) {
  const id = String(rawId || "").trim();
  const code = String(rawCode || "").trim();
  const filters = [];
  if (id && require("mongoose").isValidObjectId(id)) filters.push({ _id: id });
  if (id) filters.push({ bookingCode: id });
  if (code) filters.push({ bookingCode: code });
  if (!filters.length) return null;
  return Booking.findOne({ userId, $or: filters }).select("_id bookingCode");
}

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const phone = body.phone || req.auth.phone_number || "";
    const verified = tokenPhoneVerified(req, phone);
    const now = new Date();
    const existing = await User.findOne({ firebaseUid: req.auth.uid }).select("_id").lean();
    const update = {
      firebaseUid: req.auth.uid,
      bookingRiskStatus: verified ? "trusted" : "otp_required",
      lastLoginAt: now
    };

    if (body.name || req.auth.name) update.name = body.name || req.auth.name;
    if (phone) update.phone = phone;
    if (body.email !== undefined || req.auth.email) update.email = body.email || req.auth.email || "";
    if (body.profilePhotoUrl || req.auth.picture) update.profilePhotoUrl = body.profilePhotoUrl || req.auth.picture;
    if (body.address !== undefined && body.address) update.address = body.address;
    if (body.city) update.city = body.city;
    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (body.deviceInfo) update.deviceInfo = body.deviceInfo;
    if (verified) {
      update.phoneVerified = true;
      update.phoneVerifiedAt = new Date();
    } else {
      update.phoneVerified = false;
      update.phoneVerifiedAt = null;
    }
    if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
      update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    }
    if (body.savedAddresses) {
      update.savedAddresses = body.savedAddresses.map((entry) => ({
        label: entry.label || "Saved",
        address: entry.address,
        city: entry.city || body.city || "Guwahati",
        location: {
          type: "Point",
          coordinates: [Number.isFinite(entry.lng) ? entry.lng : 0, Number.isFinite(entry.lat) ? entry.lat : 0]
        },
        isDefault: Boolean(entry.isDefault),
        updatedAt: now
      }));
    }

    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $set: update,
        $setOnInsert: {
          registrationHistory: [{
            source: "user_app",
            provider: "firebase",
            registeredAt: now,
            ip: req.ip || "",
            userAgent: req.get("user-agent") || ""
          }]
        },
        $push: {
          loginHistory: {
            $each: [{
              loggedInAt: now,
              ip: req.ip || "",
              userAgent: req.get("user-agent") || "",
              deviceInfo: body.deviceInfo || {}
            }],
            $slice: -50
          }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!existing) {
      emitAdminEvent("user:registered", {
        userId: String(user._id),
        name: user.name,
        phone: user.phone,
        email: user.email,
        createdAt: user.createdAt
      });
    }

    return res.json({ user });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
}

async function saveFcmToken(req, res, next) {
  try {
    const token = String(req.body?.fcmToken || "").trim();
    const deviceToken = normalizeDeviceToken({
      token,
      platform: req.body?.platform || "android",
      deviceId: req.body?.deviceId || "",
      appType: "user"
    });
    if (!deviceToken) {
      return res.status(400).json({ message: "Valid FCM token is required" });
    }
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          name: req.auth.name || "ApnaServo Customer",
          phone: req.auth.phone_number || "",
          email: req.auth.email || "",
          city: "Guwahati"
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upsertDeviceToken(user, deviceToken);
    await user.save();
    return res.json({ ok: true, userId: user._id });
  } catch (error) {
    return next(error);
  }
}

async function syncSupportTicket(req, res, next) {
  try {
    const body = supportTicketSyncSchema.parse(req.body || {});
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "Customer profile not found" });
    }

    const booking = await resolveBooking(body.bookingId, body.bookingCode, user._id);
    const now = new Date();
    const attachment = body.attachmentUrl ? {
      name: body.attachmentName || "Customer attachment",
      url: body.attachmentUrl,
      mimeType: body.attachmentMimeType || "image/jpeg",
      uploadedAt: now
    } : null;
    let ticket = await SupportTicket.findOne({ ticketCode: body.ticketId, userId: user._id });
    const isNew = !ticket;

    if (!ticket) {
      ticket = new SupportTicket({
        ticketCode: body.ticketId,
        userId: user._id,
        bookingId: booking?._id || null,
        bookingCode: booking?.bookingCode || body.bookingCode || "",
        userName: user.name || "",
        mobileNumber: user.phone || "",
        email: user.email || "",
        category: supportCategory(body.message, body.category),
        priority: supportPriority(body.message, body.priority),
        status: "open",
        source: "ai_support",
        complaint: body.message,
        aiSummary: body.aiSummary || `AI Support captured a ${supportCategory(body.message, body.category)} issue from ${user.name || "the customer"}.`,
        timeline: [{ event: "ticket_created", by: "ai_support", note: "Ticket synced from User App", at: now }],
        lastUpdatedAt: now
      });
    }

    const duplicate = body.clientMessageId
      && ticket.conversation.some((entry) => entry.clientMessageId === body.clientMessageId);
    if (!duplicate) {
      ticket.conversation.push({
        clientMessageId: body.clientMessageId || "",
        senderRole: body.senderRole,
        senderName: body.senderName || (body.senderRole === "ai" ? "ApnaServo AI Support" : user.name),
        message: body.message,
        attachments: attachment ? [attachment] : [],
        createdAt: now
      });
      ticket.timeline.push({
        event: body.senderRole === "user" ? "customer_message" : `${body.senderRole}_message`,
        by: body.senderRole,
        note: body.message.slice(0, 180),
        at: now
      });
    }
    if (attachment && !ticket.attachments.some((entry) => entry.url === attachment.url)) {
      ticket.attachments.push(attachment);
    }
    if (booking && !ticket.bookingId) {
      ticket.bookingId = booking._id;
      ticket.bookingCode = booking.bookingCode;
    }
    if (body.aiSummary) ticket.aiSummary = body.aiSummary;
    ticket.lastUpdatedAt = now;
    await ticket.save();

    emitAdminEvent(isNew ? "support:ticket_created" : "support:ticket_updated", {
      ticketId: ticket.ticketCode,
      userId: String(user._id),
      userName: user.name,
      status: ticket.status,
      priority: ticket.priority
    });

    return res.status(isNew ? 201 : 200).json({
      ok: true,
      ticketId: ticket.ticketCode,
      supportTicketId: String(ticket._id),
      status: ticket.status,
      idempotent: Boolean(duplicate)
    });
  } catch (error) {
    return next(error);
  }
}

async function requestDeletion(req, res, next) {
  try {
    const body = deletionRequestSchema.parse(req.body || {});
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $set: {
          accountStatus: "deletion_requested",
           deletionRequestedAt: new Date(),
           deletionReason: body.reason || "Customer requested account deletion from Android app",
           fcmToken: "",
           deviceTokens: []
         },
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          name: req.auth.name || "ApnaServo Customer",
          phone: req.auth.phone_number || "",
          email: req.auth.email || "",
          city: "Guwahati"
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({
      ok: true,
      accountStatus: user.accountStatus,
      deletionRequestedAt: user.deletionRequestedAt
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  upsertProfile,
  me,
  saveFcmToken,
  syncSupportTicket,
  requestDeletion
};
