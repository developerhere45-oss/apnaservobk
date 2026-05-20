const mongoose = require("mongoose");

const BOOKING_STATUSES = [
  "pending",
  "sent_to_partner",
  "accepted",
  "rejected",
  "on_the_way",
  "arrived",
  "started",
  "amount_pending",
  "completed",
  "cancelled"
];

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    bookingCode: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null, index: true },
    serviceCategory: { type: String, required: true, index: true },
    serviceName: { type: String, default: "Service" },
    issue: { type: String, default: "Service request" },
    address: { type: String, required: true },
    city: { type: String, default: "Guwahati", index: true },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [91.7362, 26.1445] }) },
    status: { type: String, enum: BOOKING_STATUSES, default: "pending", index: true },
    price: { type: Number, default: 0 },
    finalAmount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending" },
    requestedPartners: [{ type: mongoose.Schema.Types.ObjectId, ref: "Partner" }],
    rejectedPartners: [{ type: mongoose.Schema.Types.ObjectId, ref: "Partner" }],
    userSnapshot: {
      name: String,
      phone: String,
      email: String,
      fcmToken: String
    },
    partnerSnapshot: {
      name: String,
      phone: String,
      rating: Number,
      fcmToken: String
    },
    slot: { type: String, default: "" },
    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    statusTimeline: [
      {
        status: String,
        at: Date,
        by: String
      }
    ]
  },
  { timestamps: true }
);

bookingSchema.index({ location: "2dsphere" });
bookingSchema.index({ serviceCategory: 1, status: 1, city: 1, createdAt: -1 });

module.exports = {
  Booking: mongoose.model("Booking", bookingSchema),
  BOOKING_STATUSES
};
