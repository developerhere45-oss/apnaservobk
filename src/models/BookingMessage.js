const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");

const bookingMessageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingCode: { type: String, default: "", trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", required: true, index: true },
    senderRole: { type: String, enum: ["user", "partner"], required: true, index: true },
    senderFirebaseUid: { type: String, default: "", trim: true, index: true },
    senderName: { type: String, default: "", trim: true },
    message: { type: String, required: true, trim: true },
    clientMessageId: { type: String, default: "", trim: true },
    deliveryStatus: {
      type: String,
      enum: ["queued", "sent", "delivered", "seen", "failed"],
      default: "sent",
      index: true
    },
    deliveredAt: { type: Date, default: null },
    seenAt: { type: Date, default: null },
    attachmentUrl: { type: String, default: "", trim: true },
    attachmentType: { type: String, enum: ["none", "image"], default: "none" },
    fraudFlagged: { type: Boolean, default: false, index: true },
    fraudSeverity: { type: String, enum: ["low", "medium", "high"], default: "low" },
    matchedTerms: [{ type: String }]
  },
  { timestamps: true }
);

bookingMessageSchema.index(
  { bookingId: 1, senderRole: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: "string", $gt: "" } }
  }
);
bookingMessageSchema.index({ bookingId: 1, createdAt: 1 });
bookingMessageSchema.index({ userId: 1, createdAt: -1 });
bookingMessageSchema.index({ partnerId: 1, createdAt: -1 });
bookingMessageSchema.index({ senderFirebaseUid: 1, createdAt: -1 });

bookingMessageSchema.plugin(encryptedFieldsPlugin, {
  fields: ["senderName", "message", "attachmentUrl"]
});

module.exports = mongoose.model("BookingMessage", bookingMessageSchema);
