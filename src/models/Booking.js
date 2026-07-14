const mongoose = require("mongoose");
const encryptedFieldsPlugin = require("../utils/encryptedFieldsPlugin");
const { BOOKING_STATUSES } = require("../utils/bookingLifecycle");

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
    emergency: {
      isEmergency: { type: Boolean, default: false, index: true },
      type: {
        type: String,
        enum: ["none", "electric_short_circuit", "water_leakage", "ac_breakdown", "other"],
        default: "none",
        index: true
      },
      priority: { type: String, enum: ["normal", "urgent", "critical"], default: "normal", index: true },
      notes: { type: String, default: "" },
      requestedAt: { type: Date, default: null }
    },
    price: { type: Number, default: 0 },
    finalAmount: { type: Number, default: 0 },
    amountRequestedAt: { type: Date, default: null },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending" },
    customerVerification: {
      phoneVerified: { type: Boolean, default: false },
      otpRequired: { type: Boolean, default: false },
      authPhone: { type: String, default: "" },
      verifiedAt: { type: Date, default: null },
      riskStatus: { type: String, default: "unknown" }
    },
    quoteAmount: { type: Number, default: 0 },
    quoteStatus: {
      type: String,
      enum: ["none", "pending", "payment_submitted", "approved", "countered", "expired", "rejected"],
      default: "none",
      index: true
    },
    quoteRequestedAt: { type: Date, default: null },
    paymentSubmittedAt: { type: Date, default: null },
    quoteExpiresAt: { type: Date, default: null },
    quoteApprovedAt: { type: Date, default: null },
    quoteCounterAmount: { type: Number, default: 0 },
    quoteCounterMessage: { type: String, default: "" },
    quoteCounterAt: { type: Date, default: null },
    quoteHistory: [
      {
        kind: String,
        amount: Number,
        by: String,
        message: String,
        at: Date
      }
    ],
    noResponseReport: {
      reported: { type: Boolean, default: false },
      reportedAt: { type: Date, default: null },
      reason: { type: String, default: "" },
      lat: { type: Number, default: 0 },
      lng: { type: Number, default: 0 },
      accuracy: { type: Number, default: 9999 },
      evidenceUrl: { type: String, default: "" }
    },
    reviewSnapshot: {
      reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", default: null },
      rating: { type: Number, default: 0 },
      status: { type: String, default: "" },
      disputeStatus: { type: String, default: "none" },
      reviewedAt: { type: Date, default: null }
    },
    requestedPartners: [{ type: mongoose.Schema.Types.ObjectId, ref: "Partner" }],
    rejectedPartners: [{ type: mongoose.Schema.Types.ObjectId, ref: "Partner" }],
    dispatchRadiusKm: { type: Number, default: 0 },
    dispatchMode: { type: String, enum: ["", "customer_location", "city_fallback"], default: "" },
    dispatchAttempt: { type: Number, default: 0 },
    dispatchedAt: { type: Date, default: null },
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
      ratingCount: { type: Number, default: 0 },
      photoUrl: String,
      fcmToken: String
    },
    slot: { type: String, default: "" },
    partnerArrivalEstimateMinutes: { type: Number, default: 0, min: 0, max: 1440 },
    partnerArrivalEstimateLabel: { type: String, default: "" },
    expectedArrivalAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    warranty: {
      eligible: { type: Boolean, default: false, index: true },
      serviceDate: { type: Date, default: null },
      warrantyDays: { type: Number, default: 0 },
      warrantyEndDate: { type: Date, default: null, index: true },
      revisitRequested: { type: Boolean, default: false },
      revisitRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "RevisitRequest", default: null }
    },
    proofSummary: {
      beforeCount: { type: Number, default: 0 },
      afterCount: { type: Number, default: 0 },
      lastUploadedAt: { type: Date, default: null }
    },
    completionAccounting: {
      creditedAt: { type: Date, default: null },
      grossAmount: { type: Number, default: 0 }
    },
    latestSosId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianSos", default: null },
    statusTimeline: [
      {
        status: String,
        at: Date,
        by: String,
        note: String
      }
    ]
  },
  { timestamps: true }
);

bookingSchema.index({ location: "2dsphere" });
bookingSchema.index({ serviceCategory: 1, status: 1, city: 1, createdAt: -1 });
bookingSchema.index({ status: 1, serviceCategory: 1, createdAt: -1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ partnerId: 1, createdAt: -1 });
bookingSchema.index({ partnerId: 1, status: 1, updatedAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ status: 1, serviceCategory: 1, city: 1, rejectedPartners: 1, createdAt: -1 });
bookingSchema.index({ requestedPartners: 1, status: 1, createdAt: -1 });
bookingSchema.index({ quoteStatus: 1, quoteExpiresAt: 1 });
bookingSchema.index({ paymentStatus: 1, updatedAt: -1 });
bookingSchema.index({ "emergency.isEmergency": 1, "emergency.priority": 1, status: 1, createdAt: -1 });
bookingSchema.index({ "warranty.warrantyEndDate": 1, "warranty.revisitRequested": 1 });
bookingSchema.index({ "completionAccounting.creditedAt": 1, status: 1 });
bookingSchema.plugin(encryptedFieldsPlugin, {
  fields: [
    "serviceName",
    "issue",
    "address",
    "slot",
    "partnerArrivalEstimateLabel",
    "emergency.notes",
    "quoteCounterMessage",
    "quoteHistory.message",
    "customerVerification.authPhone",
    "noResponseReport.reason",
    "noResponseReport.evidenceUrl",
    "userSnapshot.name",
    "userSnapshot.phone",
    "userSnapshot.email",
    "userSnapshot.fcmToken",
    "partnerSnapshot.name",
    "partnerSnapshot.phone",
    "partnerSnapshot.fcmToken"
  ]
});

module.exports = {
  Booking: mongoose.model("Booking", bookingSchema),
  BOOKING_STATUSES
};
