const mongoose = require("mongoose");

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  },
  { _id: false }
);

const partnerSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    partnerCode: { type: String, unique: true, sparse: true },
    name: { type: String, trim: true, default: "ApnaServo Partner" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    serviceCategory: { type: [String], default: ["ac"] },
    isOnline: { type: Boolean, default: true, index: true },
    isVerified: { type: Boolean, default: true },
    city: { type: String, trim: true, default: "Guwahati" },
    serviceArea: { type: String, trim: true, default: "Guwahati, Assam" },
    serviceRadiusKm: { type: Number, default: 25 },
    location: { type: pointSchema, default: () => ({ type: "Point", coordinates: [91.7362, 26.1445] }) },
    earnings: { type: Number, default: 0 },
    rating: { type: Number, default: 4.8 },
    totalJobs: { type: Number, default: 0 },
    responseRate: { type: Number, default: 92 },
    fcmToken: { type: String, default: "" },
    photoUrl: { type: String, default: "" }
  },
  { timestamps: true }
);

partnerSchema.index({ location: "2dsphere" });
partnerSchema.index({ serviceCategory: 1, isOnline: 1, city: 1 });

module.exports = mongoose.model("Partner", partnerSchema);
