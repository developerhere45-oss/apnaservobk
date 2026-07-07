const mongoose = require("mongoose");
const { z } = require("zod");
const ChatAssignment = require("../models/ChatAssignment");
const EmployeeActivityLog = require("../models/EmployeeActivityLog");
const BookingMessage = require("../models/BookingMessage");
const Partner = require("../models/Partner");
const User = require("../models/User");
const { Booking, BOOKING_STATUSES } = require("../models/Booking");
const { getDisplayName, id, maskEmail, maskPhone, safeText, toSafeObject } = require("../utils/safeDisplay");

const bookingStatusSchema = z.object({
  status: z.enum(BOOKING_STATUSES)
});

const noteSchema = z.object({
  note: z.string().min(1).max(1000)
});

const chatMessageSchema = z.object({
  message: z.string().min(1).max(1000),
  clientMessageId: z.string().max(120).optional()
});

const chatStatusSchema = z.object({
  status: z.enum(["assigned", "open", "in_progress", "waiting", "resolved", "closed"])
});

function requestMeta(req) {
  return {
    ipAddress: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] || "")
  };
}

async function logEmployee(req, action, module, targetId, details = {}) {
  await EmployeeActivityLog.create({
    employeeId: req.employeeProfile._id,
    action,
    module,
    targetId: mongoose.Types.ObjectId.isValid(String(targetId || "")) ? targetId : null,
    details,
    ...requestMeta(req)
  }).catch(() => undefined);
}

function normalizeStatus(status) {
  return safeText(status, "pending").replace(/_/g, " ");
}

function serializeBooking(booking) {
  const doc = toSafeObject(booking);
  return {
    id: id(doc._id),
    bookingCode: safeText(doc.bookingCode, ""),
    customer: getDisplayName(doc.userSnapshot, "Customer"),
    customerPhone: maskPhone(doc.userSnapshot?.phone),
    service: safeText(doc.serviceName || doc.serviceCategory, "Service"),
    partner: getDisplayName(doc.partnerSnapshot, "Partner"),
    date: doc.createdAt,
    time: safeText(doc.slot, ""),
    status: safeText(doc.status, "pending"),
    statusLabel: normalizeStatus(doc.status),
    address: safeText(doc.address, "Hidden")
  };
}

function serializePartner(partner) {
  const doc = toSafeObject(partner);
  return {
    id: id(doc._id),
    name: getDisplayName(doc, "Partner"),
    phone: maskPhone(doc.phone),
    serviceCategory: Array.isArray(doc.serviceCategory) ? doc.serviceCategory.join(", ") : safeText(doc.serviceCategory, "Service"),
    city: safeText(doc.city || doc.serviceArea, "Hidden"),
    status: safeText(doc.accountStatus, "active"),
    verificationStatus: doc.isVerified || doc.kycStatus === "verified" ? "verified" : safeText(doc.kycStatus, "pending_review"),
    rating: Number(doc.rating || 0)
  };
}

function serializeUser(user, bookingCount = 0, lastBookingDate = null) {
  const doc = toSafeObject(user);
  return {
    id: id(doc._id),
    name: getDisplayName(doc, "Customer"),
    phone: maskPhone(doc.phone),
    city: safeText(doc.city, "Hidden"),
    totalBookings: bookingCount,
    lastBookingDate,
    status: safeText(doc.accountStatus, "active")
  };
}

function serializeChat(assignment, booking, lastMessage) {
  const bookingDoc = toSafeObject(booking) || {};
  return {
    id: id(assignment._id),
    chatId: id(assignment.chatId),
    bookingId: id(assignment.bookingId || assignment.chatId),
    bookingCode: safeText(bookingDoc.bookingCode, ""),
    customerName: getDisplayName(bookingDoc.userSnapshot, "Customer"),
    customerPhone: maskPhone(bookingDoc.userSnapshot?.phone),
    customerEmail: maskEmail(bookingDoc.userSnapshot?.email),
    customerAddress: safeText(bookingDoc.address, "Hidden"),
    service: safeText(bookingDoc.serviceName || bookingDoc.serviceCategory, "Service"),
    bookingDate: bookingDoc.createdAt,
    preferredTime: safeText(bookingDoc.slot, ""),
    bookingStatus: safeText(bookingDoc.status, "pending"),
    priority: assignment.priority,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    assignedBy: id(assignment.assignedBy),
    internalNote: safeText(assignment.internalNote, ""),
    lastMessage: lastMessage ? safeText(lastMessage.message, "") : "",
    lastMessageAt: lastMessage?.createdAt || assignment.updatedAt,
    unreadCount: 0
  };
}

async function dashboard(req, res, next) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todayBookings, pendingBookings, activePartners, openIssues, assignedChats, resolvedToday, recentBookings, recentAssignments, pendingPartners] = await Promise.all([
      Booking.countDocuments({ createdAt: { $gte: today } }),
      Booking.countDocuments({ status: { $in: ["pending", "confirmed", "searching", "sent_to_partner"] } }),
      Partner.countDocuments({ accountStatus: "active", isVerified: true }),
      ChatAssignment.countDocuments({ status: { $in: ["assigned", "open", "in_progress", "waiting"] } }),
      ChatAssignment.countDocuments({ assignedTo: req.employeeProfile._id, status: { $ne: "closed" } }),
      ChatAssignment.countDocuments({ assignedTo: req.employeeProfile._id, status: "resolved", updatedAt: { $gte: today } }),
      Booking.find().sort({ createdAt: -1 }).limit(5),
      ChatAssignment.find({ assignedTo: req.employeeProfile._id }).sort({ updatedAt: -1 }).limit(5),
      Partner.find({ kycStatus: { $in: ["submitted", "pending_review"] } }).sort({ createdAt: -1 }).limit(5)
    ]);
    const hydratedChats = await hydrateEmployeeChats(recentAssignments);
    return res.json({
      metrics: {
        todayBookings,
        pendingBookings,
        activePartners,
        openUserIssues: openIssues,
        assignedChats,
        chatsResolvedToday: resolvedToday
      },
      recentBookings: recentBookings.map(serializeBooking),
      recentAssignedChats: hydratedChats,
      pendingPartnerChecks: pendingPartners.map(serializePartner)
    });
  } catch (error) {
    return next(error);
  }
}

async function listBookings(req, res, next) {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const query = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { bookingCode: new RegExp(search, "i") },
        { serviceCategory: new RegExp(search, "i") }
      ];
    }
    const bookings = await Booking.find(query).sort({ createdAt: -1 }).limit(150);
    return res.json({ rows: bookings.map(serializeBooking), bookings: bookings.map(serializeBooking) });
  } catch (error) {
    return next(error);
  }
}

async function getBooking(req, res, next) {
  try {
    const booking = await Booking.findOne(mongoose.Types.ObjectId.isValid(req.params.id) ? { $or: [{ _id: req.params.id }, { bookingCode: req.params.id }] } : { bookingCode: req.params.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    return res.json({ booking: serializeBooking(booking), timeline: booking.statusTimeline || [] });
  } catch (error) {
    return next(error);
  }
}

async function updateBookingStatus(req, res, next) {
  try {
    const body = bookingStatusSchema.parse(req.body || {});
    const booking = await Booking.findOne(mongoose.Types.ObjectId.isValid(req.params.id) ? { $or: [{ _id: req.params.id }, { bookingCode: req.params.id }] } : { bookingCode: req.params.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    booking.status = body.status;
    booking.statusTimeline.push({ status: body.status, at: new Date(), by: `employee:${req.employeeProfile.employeeId}` });
    await booking.save();
    await logEmployee(req, "update_status", "bookings", booking._id, { status: body.status });
    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function addBookingNote(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    const booking = await Booking.findOne(mongoose.Types.ObjectId.isValid(req.params.id) ? { $or: [{ _id: req.params.id }, { bookingCode: req.params.id }] } : { bookingCode: req.params.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    booking.statusTimeline.push({ status: "employee_note", at: new Date(), by: `${req.employeeProfile.employeeId}: ${body.note}` });
    await booking.save();
    await logEmployee(req, "add_note", "bookings", booking._id, { note: body.note });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function listPartners(_req, res, next) {
  try {
    const partners = await Partner.find().sort({ createdAt: -1 }).limit(150);
    return res.json({ rows: partners.map(serializePartner), partners: partners.map(serializePartner) });
  } catch (error) {
    return next(error);
  }
}

async function getPartner(req, res, next) {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ message: "Partner not found" });
    return res.json({ partner: serializePartner(partner) });
  } catch (error) {
    return next(error);
  }
}

async function addPartnerNote(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    await logEmployee(req, "add_note", "partners", req.params.id, { note: body.note });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function updatePartnerVerification(req, res, next) {
  try {
    const status = String(req.body?.status || "");
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid status" });
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ message: "Partner not found" });
    if (status === "approved") {
      partner.isVerified = true;
      partner.kycStatus = "verified";
      partner.trustStatus = "trusted";
      partner.approvedAt = new Date();
    } else {
      partner.isVerified = false;
      partner.kycStatus = "rejected";
      partner.rejectedAt = new Date();
    }
    partner.verificationHistory.push({ action: status === "approved" ? "approved" : "rejected", by: `employee:${req.employeeProfile.employeeId}`, at: new Date() });
    await partner.save();
    await logEmployee(req, "verification_update", "partners", partner._id, { status });
    return res.json({ partner: serializePartner(partner) });
  } catch (error) {
    return next(error);
  }
}

async function listUsers(_req, res, next) {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(150);
    const userIds = users.map((user) => user._id);
    const bookings = await Booking.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$userId", total: { $sum: 1 }, lastBookingDate: { $first: "$createdAt" } } }
    ]);
    const bookingMap = new Map(bookings.map((entry) => [String(entry._id), entry]));
    const rows = users.map((user) => {
      const summary = bookingMap.get(String(user._id)) || {};
      return serializeUser(user, summary.total || 0, summary.lastBookingDate || null);
    });
    return res.json({ rows, users: rows });
  } catch (error) {
    return next(error);
  }
}

async function getUser(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const bookings = await Booking.find({ userId: user._id }).sort({ createdAt: -1 }).limit(25);
    return res.json({ user: serializeUser(user, bookings.length, bookings[0]?.createdAt || null), bookings: bookings.map(serializeBooking) });
  } catch (error) {
    return next(error);
  }
}

async function addUserNote(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    await logEmployee(req, "add_note", "users", req.params.id, { note: body.note });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function hydrateEmployeeChats(assignments) {
  const bookingIds = assignments.map((assignment) => assignment.bookingId || assignment.chatId).filter(Boolean);
  const [bookings, messages] = await Promise.all([
    Booking.find({ _id: { $in: bookingIds } }),
    BookingMessage.find({ bookingId: { $in: bookingIds } }).sort({ createdAt: -1 }).limit(Math.max(bookingIds.length * 3, 30))
  ]);
  const bookingMap = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const messageMap = new Map();
  for (const message of messages) {
    const key = String(message.bookingId);
    if (!messageMap.has(key)) messageMap.set(key, message);
  }
  return assignments.map((assignment) => {
    const booking = bookingMap.get(String(assignment.bookingId || assignment.chatId));
    return serializeChat(assignment, booking, messageMap.get(String(booking?._id)));
  });
}

async function listChats(req, res, next) {
  try {
    const filter = { assignedTo: req.employeeProfile._id };
    const status = String(req.query.status || "").trim();
    if (status) filter.status = status;
    const assignments = await ChatAssignment.find(filter).sort({ updatedAt: -1 }).limit(150);
    const rows = await hydrateEmployeeChats(assignments);
    return res.json({
      rows,
      chats: rows,
      metrics: {
        assignedToday: rows.filter((row) => new Date(row.assignedAt).toDateString() === new Date().toDateString()).length,
        openChats: rows.filter((row) => ["assigned", "open"].includes(row.status)).length,
        inProgress: rows.filter((row) => row.status === "in_progress").length,
        resolvedToday: rows.filter((row) => row.status === "resolved").length
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function getChat(req, res, next) {
  try {
    const assignment = req.chatAssignment;
    const booking = await Booking.findById(assignment.bookingId || assignment.chatId);
    const messages = await BookingMessage.find({ bookingId: assignment.bookingId || assignment.chatId }).sort({ createdAt: 1 }).limit(200);
    return res.json({
      chat: serializeChat(assignment, booking, messages[messages.length - 1]),
      messages: messages.map((message) => ({
        id: id(message._id),
        senderType: message.senderRole,
        senderName: safeText(message.senderName, message.senderRole),
        message: safeText(message.message, ""),
        createdAt: message.createdAt,
        deliveryStatus: message.deliveryStatus
      }))
    });
  } catch (error) {
    return next(error);
  }
}

async function sendChatMessage(req, res, next) {
  try {
    const body = chatMessageSchema.parse(req.body || {});
    const assignment = req.chatAssignment;
    const booking = await Booking.findById(assignment.bookingId || assignment.chatId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const message = await BookingMessage.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      userId: booking.userId,
      partnerId: booking.partnerId,
      senderRole: "employee",
      senderFirebaseUid: String(req.employeeProfile._id),
      senderName: req.employeeProfile.name,
      message: body.message,
      clientMessageId: body.clientMessageId || "",
      deliveryStatus: "sent"
    });
    assignment.status = assignment.status === "assigned" ? "open" : assignment.status;
    await assignment.save();
    await logEmployee(req, "send_message", "chats", assignment._id, { bookingId: String(booking._id) });
    return res.status(201).json({
      message: {
        id: id(message._id),
        senderType: "employee",
        senderName: req.employeeProfile.name,
        message: body.message,
        createdAt: message.createdAt,
        deliveryStatus: "sent"
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function updateChatStatus(req, res, next) {
  try {
    const body = chatStatusSchema.parse(req.body || {});
    const assignment = req.chatAssignment;
    assignment.status = body.status;
    if (["closed", "resolved"].includes(body.status)) assignment.closedAt = new Date();
    await assignment.save();
    await logEmployee(req, "update_status", "chats", assignment._id, { status: body.status });
    return res.json({ chat: (await hydrateEmployeeChats([assignment]))[0] });
  } catch (error) {
    return next(error);
  }
}

async function requestTransfer(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    const assignment = req.chatAssignment;
    assignment.transferRequests.push({
      note: body.note,
      addedBy: req.employeeProfile.name,
      addedByType: "employee",
      addedAt: new Date()
    });
    await assignment.save();
    await logEmployee(req, "request_transfer", "chats", assignment._id, { note: body.note });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function addChatNote(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    const assignment = req.chatAssignment;
    assignment.internalNote = body.note;
    assignment.internalNotes.push({
      note: body.note,
      addedBy: req.employeeProfile.name,
      addedByType: "employee",
      addedAt: new Date()
    });
    await assignment.save();
    await logEmployee(req, "add_note", "chats", assignment._id, { note: body.note });
    return res.json({ chat: (await hydrateEmployeeChats([assignment]))[0] });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addBookingNote,
  addChatNote,
  addPartnerNote,
  addUserNote,
  dashboard,
  getBooking,
  getChat,
  getPartner,
  getUser,
  listBookings,
  listChats,
  listPartners,
  listUsers,
  requestTransfer,
  sendChatMessage,
  updateBookingStatus,
  updateChatStatus,
  updatePartnerVerification
};
