const mongoose = require("mongoose");
const { z } = require("zod");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");
const BookingMessage = require("../models/BookingMessage");
const { scanFraudText, recordFraudSignal } = require("../utils/fraudDetection");
const { reliableNotify } = require("../utils/reliableNotify");
const { emitBookingChatMessage, emitBookingChatSeen } = require("../sockets/bookingSocket");

const sendMessageSchema = z.object({
  message: z.string().min(1).max(1000),
  clientMessageId: z.string().max(120).optional(),
  attachmentUrl: z.string().max(1000).optional(),
  attachmentType: z.enum(["none", "image"]).optional()
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(150).optional(),
  before: z.string().optional()
});

function bookingIdFilter(bookingId) {
  return mongoose.Types.ObjectId.isValid(bookingId)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(bookingId) }, { bookingCode: bookingId }] }
    : { bookingCode: bookingId };
}

function millis(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

async function resolveActor(req, booking) {
  const [user, partner] = await Promise.all([
    User.findOne({ firebaseUid: req.auth.uid }),
    Partner.findOne({ firebaseUid: req.auth.uid })
  ]);

  if (user && String(booking.userId || "") === String(user._id)) {
    return { role: "user", user, partner: null, name: user.name || booking.userSnapshot?.name || "Customer" };
  }
  if (partner && String(booking.partnerId || "") === String(partner._id)) {
    return { role: "partner", user: null, partner, name: partner.name || booking.partnerSnapshot?.name || "Partner" };
  }
  return null;
}

function recipientFor(actor, booking, user, partner) {
  if (actor.role === "user") {
    return {
      role: "partner",
      partnerId: booking.partnerId,
      firebaseUid: partner?.firebaseUid || "",
      token: partner?.fcmToken || booking.partnerSnapshot?.fcmToken || "",
      phone: partner?.phone || booking.partnerSnapshot?.phone || ""
    };
  }
  return {
    role: "user",
    userId: booking.userId,
    firebaseUid: user?.firebaseUid || "",
    token: user?.fcmToken || booking.userSnapshot?.fcmToken || "",
    phone: user?.phone || booking.userSnapshot?.phone || ""
  };
}

function serializeMessage(message) {
  const doc = typeof message.toObject === "function" ? message.toObject() : message;
  return {
    id: String(doc._id),
    bookingId: String(doc.bookingId),
    bookingCode: doc.bookingCode || "",
    userId: doc.userId ? String(doc.userId) : "",
    partnerId: doc.partnerId ? String(doc.partnerId) : "",
    senderRole: doc.senderRole,
    senderFirebaseUid: doc.senderFirebaseUid || "",
    senderName: doc.senderName || "",
    message: doc.message || "",
    clientMessageId: doc.clientMessageId || "",
    deliveryStatus: doc.deliveryStatus || "sent",
    deliveredAt: doc.deliveredAt || null,
    deliveredAtMillis: millis(doc.deliveredAt),
    seenAt: doc.seenAt || null,
    seenAtMillis: millis(doc.seenAt),
    attachmentUrl: doc.attachmentUrl || "",
    attachmentType: doc.attachmentType || "none",
    fraudFlagged: Boolean(doc.fraudFlagged),
    fraudSeverity: doc.fraudSeverity || "low",
    matchedTerms: doc.matchedTerms || [],
    createdAt: doc.createdAt || null,
    createdAtMillis: millis(doc.createdAt),
    updatedAt: doc.updatedAt || null,
    updatedAtMillis: millis(doc.updatedAt)
  };
}

async function loadChatContext(req, res) {
  const booking = await Booking.findOne(bookingIdFilter(String(req.params.bookingId || "")));
  if (!booking) {
    res.status(404).json({ message: "Booking not found" });
    return null;
  }
  if (!booking.partnerId) {
    res.status(409).json({ message: "Partner is not assigned yet" });
    return null;
  }
  const actor = await resolveActor(req, booking);
  if (!actor) {
    res.status(403).json({ message: "Not allowed to access this booking chat" });
    return null;
  }
  const [user, partner] = await Promise.all([
    User.findById(booking.userId),
    Partner.findById(booking.partnerId)
  ]);
  return { booking, actor, user, partner };
}

async function listMessages(req, res, next) {
  try {
    const context = await loadChatContext(req, res);
    if (!context) return;
    const query = listMessagesSchema.parse(req.query || {});
    const filter = { bookingId: context.booking._id };
    if (query.before) {
      const before = new Date(query.before);
      if (!Number.isNaN(before.getTime())) {
        filter.createdAt = { $lt: before };
      }
    }
    const limit = query.limit || 80;
    const messages = await BookingMessage.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);

    const otherRole = context.actor.role === "user" ? "partner" : "user";
    await BookingMessage.updateMany(
      {
        bookingId: context.booking._id,
        senderRole: otherRole,
        deliveryStatus: { $in: ["queued", "sent"] }
      },
      { $set: { deliveryStatus: "delivered", deliveredAt: new Date() } }
    );

    return res.json({
      messages: messages.reverse().map(serializeMessage),
      bookingId: String(context.booking._id),
      bookingCode: context.booking.bookingCode
    });
  } catch (error) {
    return next(error);
  }
}

async function sendMessage(req, res, next) {
  try {
    const body = sendMessageSchema.parse(req.body || {});
    const context = await loadChatContext(req, res);
    if (!context) return;

    const fraudPreview = scanFraudText(body.message);

    const messageData = {
      bookingId: context.booking._id,
      bookingCode: context.booking.bookingCode,
      userId: context.booking.userId,
      partnerId: context.booking.partnerId,
      senderRole: context.actor.role,
      senderFirebaseUid: req.auth.uid,
      senderName: context.actor.name,
      message: body.message,
      clientMessageId: body.clientMessageId || "",
      deliveryStatus: "sent",
      attachmentUrl: body.attachmentUrl || "",
      attachmentType: body.attachmentType || "none",
      fraudFlagged: fraudPreview.flagged,
      fraudSeverity: fraudPreview.severity,
      matchedTerms: fraudPreview.matchedTerms || []
    };

    let message;
    let duplicate = false;
    if (messageData.clientMessageId) {
      message = await BookingMessage.findOne({
        bookingId: context.booking._id,
        senderRole: context.actor.role,
        clientMessageId: messageData.clientMessageId
      });
      if (message) {
        duplicate = true;
      } else {
        try {
          message = await BookingMessage.create(messageData);
        } catch (error) {
          if (error && error.code === 11000) {
            duplicate = true;
            message = await BookingMessage.findOne({
              bookingId: context.booking._id,
              senderRole: context.actor.role,
              clientMessageId: messageData.clientMessageId
            });
          } else {
            throw error;
          }
        }
      }
    } else {
      message = await BookingMessage.create(messageData);
    }

    let fraudScan = fraudPreview;
    if (!duplicate && fraudPreview.flagged) {
      fraudScan = await recordFraudSignal({
        booking: context.booking,
        partnerId: context.booking.partnerId,
        userId: context.booking.userId,
        actorRole: context.actor.role,
        source: "booking_chat",
        message: body.message,
        metadata: { clientMessageId: body.clientMessageId || "" }
      });
    }

    const payload = serializeMessage(message);
    emitBookingChatMessage(context.booking, payload);

    if (!duplicate) {
      const recipient = recipientFor(context.actor, context.booking, context.user, context.partner);
      await reliableNotify({
        recipients: [recipient],
        title: context.actor.role === "user" ? "Customer message" : "Partner message",
        body: body.message.length > 80 ? `${body.message.slice(0, 77)}...` : body.message,
        type: "booking_chat",
        category: "chat",
        priority: "normal",
        data: {
          type: "booking:chat_message",
          bookingId: String(context.booking._id),
          bookingCode: context.booking.bookingCode,
          messageId: String(message._id),
          senderRole: context.actor.role
        },
        smsBody: `ApnaServo: New chat message for booking ${context.booking.bookingCode}. Open the app to reply.`
      });
    }

    return res.status(duplicate ? 200 : 201).json({
      message: payload,
      duplicate,
      fraudWarning: {
        flagged: fraudScan.flagged,
        severity: fraudScan.severity,
        matchedTerms: fraudScan.matchedTerms || []
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function markSeen(req, res, next) {
  try {
    const context = await loadChatContext(req, res);
    if (!context) return;
    const now = new Date();
    const otherRole = context.actor.role === "user" ? "partner" : "user";
    const result = await BookingMessage.updateMany(
      { bookingId: context.booking._id, senderRole: otherRole, deliveryStatus: { $ne: "seen" } },
      { $set: { deliveryStatus: "seen", deliveredAt: now, seenAt: now } }
    );
    const payload = {
      bookingId: String(context.booking._id),
      bookingCode: context.booking.bookingCode,
      seenByRole: context.actor.role,
      seenMessageRole: otherRole,
      seenAt: now.toISOString(),
      seenAtMillis: now.getTime(),
      modifiedCount: result.modifiedCount || 0
    };
    emitBookingChatSeen(context.booking, payload);
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listMessages,
  sendMessage,
  markSeen
};
