const mongoose = require("mongoose");

const assignmentHistorySchema = new mongoose.Schema(
  {
    action: { type: String, trim: true, default: "assigned" },
    byType: { type: String, enum: ["admin", "employee", "system"], default: "admin" },
    byName: { type: String, trim: true, default: "" },
    fromEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    toEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    note: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now }
  },
  { _id: true }
);

const internalNoteSchema = new mongoose.Schema(
  {
    note: { type: String, trim: true, default: "" },
    addedBy: { type: String, trim: true, default: "" },
    addedByType: { type: String, enum: ["admin", "employee"], default: "employee" },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const chatAssignmentSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "Booking", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal", index: true },
    status: {
      type: String,
      enum: ["assigned", "open", "in_progress", "waiting", "resolved", "closed"],
      default: "assigned",
      index: true
    },
    internalNote: { type: String, trim: true, default: "" },
    internalNotes: { type: [internalNoteSchema], default: [] },
    transferRequests: { type: [internalNoteSchema], default: [] },
    history: { type: [assignmentHistorySchema], default: [] },
    assignedAt: { type: Date, default: Date.now, index: true },
    closedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

chatAssignmentSchema.index({ chatId: 1 }, { unique: true });
chatAssignmentSchema.index({ assignedTo: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("ChatAssignment", chatAssignmentSchema);
