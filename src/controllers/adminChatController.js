const mongoose = require("mongoose");
const { z } = require("zod");
const ChatAssignment = require("../models/ChatAssignment");
const Admin = require("../models/Admin");
const Employee = require("../models/Employee");
const User = require("../models/User");
const Partner = require("../models/Partner");
const BookingMessage = require("../models/BookingMessage");
const { Booking } = require("../models/Booking");
const { getDisplayName, id, maskEmail, maskPhone, safeText, toSafeObject } = require("../utils/safeDisplay");

const assignSchema = z.object({
  employeeId: z.string().min(1),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  internalNote: z.string().max(1000).optional()
});

const prioritySchema = z.object({
  priority: z.enum(["low", "normal", "high", "urgent"])
});

const statusSchema = z.object({
  status: z.enum(["assigned", "open", "in_progress", "waiting", "resolved", "closed"])
});

const noteSchema = z.object({
  note: z.string().min(1).max(1000)
});

function bookingFilter(raw) {
  const value = String(raw || "");
  if (mongoose.Types.ObjectId.isValid(value)) {
    return { $or: [{ _id: value }, { bookingCode: value }] };
  }
  return { bookingCode: value };
}

async function hydrateAssignments(assignments) {
  const bookingIds = assignments.map((assignment) => assignment.bookingId || assignment.chatId).filter(Boolean);
  const employeeIds = assignments.map((assignment) => assignment.assignedTo).filter(Boolean);
  const adminIds = assignments.map((assignment) => assignment.assignedBy).filter(Boolean);
  const [bookings, employees, admins, lastMessages] = await Promise.all([
    Booking.find({ _id: { $in: bookingIds } }).sort({ updatedAt: -1 }),
    Employee.find({ _id: { $in: employeeIds } }),
    Admin.find({ _id: { $in: adminIds } }),
    BookingMessage.find({ bookingId: { $in: bookingIds } }).sort({ createdAt: -1 }).limit(Math.max(bookingIds.length * 3, 30))
  ]);
  const bookingMap = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const employeeMap = new Map(employees.map((employee) => [String(employee._id), employee]));
  const adminMap = new Map(admins.map((admin) => [String(admin._id), admin]));
  const messageMap = new Map();
  for (const message of lastMessages) {
    const key = String(message.bookingId);
    if (!messageMap.has(key)) messageMap.set(key, message);
  }

  return assignments.map((assignment) => {
    const booking = bookingMap.get(String(assignment.bookingId || assignment.chatId));
    const assignedTo = employeeMap.get(String(assignment.assignedTo));
    const assignedBy = adminMap.get(String(assignment.assignedBy));
    return serializeAssignment(assignment, booking, assignedTo, assignedBy, messageMap.get(String(booking?._id)));
  });
}

function serializeBookingBasics(booking) {
  if (!booking) return {};
  const doc = toSafeObject(booking);
  return {
    bookingId: id(doc._id),
    bookingCode: safeText(doc.bookingCode, ""),
    service: safeText(doc.serviceName || doc.serviceCategory, "Service"),
    serviceCategory: safeText(doc.serviceCategory, ""),
    bookingDate: doc.createdAt,
    preferredTime: safeText(doc.slot, ""),
    status: safeText(doc.status, "pending"),
    customerName: getDisplayName(doc.userSnapshot, "Customer"),
    customerPhone: maskPhone(doc.userSnapshot?.phone),
    customerEmail: maskEmail(doc.userSnapshot?.email),
    customerAddress: safeText(doc.address, "Hidden"),
    partnerName: getDisplayName(doc.partnerSnapshot, "Partner"),
    partnerPhone: maskPhone(doc.partnerSnapshot?.phone)
  };
}

function serializeAssignment(assignment, booking, assignedTo, assignedBy, lastMessage) {
  const bookingInfo = serializeBookingBasics(booking);
  return {
    id: id(assignment._id),
    chatId: id(assignment.chatId),
    bookingId: bookingInfo.bookingId || id(assignment.bookingId),
    bookingCode: bookingInfo.bookingCode,
    customerName: bookingInfo.customerName,
    service: bookingInfo.service,
    status: assignment.status,
    priority: assignment.priority,
    assignedTo: assignedTo ? assignedTo.toSafeJSON() : null,
    assignedBy: assignedBy ? assignedBy.toSafeJSON() : null,
    assignedAt: assignment.assignedAt,
    closedAt: assignment.closedAt,
    internalNote: safeText(assignment.internalNote, ""),
    internalNotes: (assignment.internalNotes || []).map((note) => ({
      id: id(note._id),
      note: safeText(note.note, ""),
      addedBy: safeText(note.addedBy, ""),
      addedByType: note.addedByType,
      addedAt: note.addedAt
    })),
    lastMessage: lastMessage ? safeText(lastMessage.message, "") : "",
    lastMessageAt: lastMessage?.createdAt || assignment.updatedAt,
    unreadCount: 0,
    booking: bookingInfo
  };
}

async function listChats(_req, res, next) {
  try {
    const assignments = await ChatAssignment.find().sort({ updatedAt: -1 }).limit(250);
    const rows = await hydrateAssignments(assignments);
    return res.json({
      rows,
      chats: rows,
      metrics: {
        totalAssigned: rows.length,
        openChats: rows.filter((row) => ["assigned", "open"].includes(row.status)).length,
        inProgress: rows.filter((row) => row.status === "in_progress").length,
        highPriority: rows.filter((row) => ["high", "urgent"].includes(row.priority)).length,
        resolvedToday: rows.filter((row) => row.status === "resolved").length
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function getChat(req, res, next) {
  try {
    const assignment = await ChatAssignment.findOne({
      $or: mongoose.Types.ObjectId.isValid(req.params.chatId)
        ? [{ _id: req.params.chatId }, { chatId: req.params.chatId }, { bookingId: req.params.chatId }]
        : []
    });
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    const booking = await Booking.findById(assignment.bookingId || assignment.chatId);
    const [assignedTo, assignedBy, messages] = await Promise.all([
      Employee.findById(assignment.assignedTo),
      assignment.assignedBy ? Admin.findById(assignment.assignedBy) : null,
      BookingMessage.find({ bookingId: assignment.bookingId || assignment.chatId }).sort({ createdAt: 1 }).limit(200)
    ]);
    return res.json({
      chat: serializeAssignment(assignment, booking, assignedTo, assignedBy, messages[messages.length - 1]),
      messages: messages.map((message) => ({
        id: id(message._id),
        senderType: message.senderRole,
        senderName: safeText(message.senderName, message.senderRole),
        message: safeText(message.message, ""),
        attachmentUrl: safeText(message.attachmentUrl, ""),
        attachmentType: message.attachmentType,
        createdAt: message.createdAt
      })),
      assignmentHistory: assignment.history || []
    });
  } catch (error) {
    return next(error);
  }
}

async function assignChat(req, res, next) {
  try {
    const body = assignSchema.parse(req.body || {});
    const [booking, employee] = await Promise.all([
      Booking.findOne(bookingFilter(req.params.chatId)),
      Employee.findById(body.employeeId)
    ]);
    if (!booking) return res.status(404).json({ message: "Booking/chat not found" });
    if (!employee || employee.status !== "active") return res.status(404).json({ message: "Active employee not found" });
    const now = new Date();
    const assignment = await ChatAssignment.findOneAndUpdate(
      { chatId: booking._id },
      {
        $set: {
          chatId: booking._id,
          bookingId: booking._id,
          userId: booking.userId,
          partnerId: booking.partnerId || null,
          assignedTo: employee._id,
          assignedBy: req.adminProfile?._id || null,
          priority: body.priority || "normal",
          status: "open",
          internalNote: body.internalNote || "",
          assignedAt: now,
          closedAt: null
        },
        $push: {
          history: {
            action: "assigned",
            byType: "admin",
            byName: req.adminProfile?.name || "Admin",
            toEmployeeId: employee._id,
            note: body.internalNote || "",
            at: now
          }
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return res.json({ chat: serializeAssignment(assignment, booking, employee, req.adminProfile, null) });
  } catch (error) {
    return next(error);
  }
}

async function transferChat(req, res, next) {
  try {
    const body = assignSchema.parse(req.body || {});
    const [assignment, employee] = await Promise.all([
      ChatAssignment.findById(req.params.chatId),
      Employee.findById(body.employeeId)
    ]);
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    if (!employee || employee.status !== "active") return res.status(404).json({ message: "Active employee not found" });
    const fromEmployeeId = assignment.assignedTo;
    assignment.assignedTo = employee._id;
    assignment.priority = body.priority || assignment.priority;
    assignment.status = "open";
    assignment.internalNote = body.internalNote || assignment.internalNote;
    assignment.history.push({
      action: "transferred",
      byType: "admin",
      byName: req.adminProfile?.name || "Admin",
      fromEmployeeId,
      toEmployeeId: employee._id,
      note: body.internalNote || "",
      at: new Date()
    });
    await assignment.save();
    return res.json({ chat: serializeAssignment(assignment, await Booking.findById(assignment.bookingId), employee, req.adminProfile, null) });
  } catch (error) {
    return next(error);
  }
}

async function removeAssignment(req, res, next) {
  try {
    const assignment = await ChatAssignment.findById(req.params.chatId);
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    assignment.status = "closed";
    assignment.closedAt = new Date();
    assignment.history.push({ action: "removed", byType: "admin", byName: req.adminProfile?.name || "Admin", at: new Date() });
    await assignment.save();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function updatePriority(req, res, next) {
  try {
    const body = prioritySchema.parse(req.body || {});
    const assignment = await ChatAssignment.findByIdAndUpdate(req.params.chatId, { $set: { priority: body.priority } }, { new: true });
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    return res.json({ chat: serializeAssignment(assignment, await Booking.findById(assignment.bookingId), null, null, null) });
  } catch (error) {
    return next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    const body = statusSchema.parse(req.body || {});
    const patch = { status: body.status };
    if (["closed", "resolved"].includes(body.status)) patch.closedAt = new Date();
    const assignment = await ChatAssignment.findByIdAndUpdate(req.params.chatId, { $set: patch }, { new: true });
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    return res.json({ chat: serializeAssignment(assignment, await Booking.findById(assignment.bookingId), null, null, null) });
  } catch (error) {
    return next(error);
  }
}

async function closeChat(req, res, next) {
  try {
    const assignment = await ChatAssignment.findByIdAndUpdate(
      req.params.chatId,
      { $set: { status: "closed", closedAt: new Date() } },
      { new: true }
    );
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    return res.json({ chat: serializeAssignment(assignment, await Booking.findById(assignment.bookingId), null, null, null) });
  } catch (error) {
    return next(error);
  }
}

async function addNote(req, res, next) {
  try {
    const body = noteSchema.parse(req.body || {});
    const assignment = await ChatAssignment.findByIdAndUpdate(
      req.params.chatId,
      {
        $push: {
          internalNotes: {
            note: body.note,
            addedBy: req.adminProfile?.name || "Admin",
            addedByType: "admin",
            addedAt: new Date()
          }
        },
        $set: { internalNote: body.note }
      },
      { new: true }
    );
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    return res.json({ chat: serializeAssignment(assignment, await Booking.findById(assignment.bookingId), null, null, null) });
  } catch (error) {
    return next(error);
  }
}

async function assignmentHistory(req, res, next) {
  try {
    const assignment = await ChatAssignment.findById(req.params.chatId);
    if (!assignment) return res.status(404).json({ message: "Chat assignment not found" });
    return res.json({ history: assignment.history || [] });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addNote,
  assignChat,
  assignmentHistory,
  closeChat,
  getChat,
  listChats,
  removeAssignment,
  transferChat,
  updatePriority,
  updateStatus
};
