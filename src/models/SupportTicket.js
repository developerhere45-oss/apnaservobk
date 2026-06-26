const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    sizeBytes: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const conversationMessageSchema = new mongoose.Schema(
  {
    clientMessageId: { type: String, trim: true, default: "" },
    senderRole: {
      type: String,
      enum: ["user", "partner", "ai", "support", "admin", "system"],
      default: "user",
      index: true
    },
    senderName: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
    attachments: { type: [attachmentSchema], default: [] },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const ticketTimelineSchema = new mongoose.Schema(
  {
    event: { type: String, trim: true, default: "" },
    by: { type: String, trim: true, default: "system" },
    note: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now }
  },
  { _id: false }
);

const adminNoteSchema = new mongoose.Schema(
  {
    note: { type: String, trim: true, default: "" },
    addedBy: { type: String, trim: true, default: "admin" },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketCode: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingCode: { type: String, trim: true, default: "", index: true },
    userName: { type: String, trim: true, default: "" },
    partnerName: { type: String, trim: true, default: "" },
    mobileNumber: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    category: { type: String, trim: true, default: "general", index: true },
    priority: { type: String, enum: ["low", "normal", "medium", "high", "urgent"], default: "normal", index: true },
    status: {
      type: String,
      enum: ["open", "assigned", "in_progress", "waiting_on_customer", "resolved", "reopened", "escalated", "closed"],
      default: "open",
      index: true
    },
    source: { type: String, enum: ["ai_support", "customer_support", "partner_app", "admin", "system"], default: "ai_support", index: true },
    complaint: { type: String, trim: true, default: "" },
    aiSummary: { type: String, trim: true, default: "" },
    conversation: { type: [conversationMessageSchema], default: [] },
    adminReplies: { type: [conversationMessageSchema], default: [] },
    internalNotes: { type: [adminNoteSchema], default: [] },
    resolutionNotes: { type: String, trim: true, default: "" },
    attachments: { type: [attachmentSchema], default: [] },
    assignedTo: { type: String, trim: true, default: "" },
    escalatedTo: { type: String, trim: true, default: "" },
    timeline: { type: [ticketTimelineSchema], default: [] },
    lastUpdatedAt: { type: Date, default: Date.now, index: true },
    resolvedAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ partnerId: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
supportTicketSchema.index({ category: 1, status: 1, createdAt: -1 });
supportTicketSchema.index({ mobileNumber: 1, createdAt: -1 });
supportTicketSchema.index({ ticketCode: 1, "conversation.clientMessageId": 1 });

supportTicketSchema.plugin(encryptedFieldsPlugin, {
  fields: [
    "userName",
    "partnerName",
    "mobileNumber",
    "email",
    "complaint",
    "aiSummary",
    "conversation.senderName",
    "conversation.message",
    "adminReplies.senderName",
    "adminReplies.message",
    "internalNotes.note",
    "resolutionNotes",
    "attachments.url"
  ]
});

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
