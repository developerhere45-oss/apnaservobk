const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema(
  {
    serviceCategory: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    basePrice: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    availability: { type: String, enum: ["AVAILABLE", "PREPARING", "HIGH_DEMAND", "TEMPORARILY_UNAVAILABLE", "DISABLED"], default: "AVAILABLE", index: true },
    availabilityMessage: { type: String, trim: true, default: "" },
    availabilityStartsAt: { type: Date, default: null },
    availabilityEndsAt: { type: Date, default: null }
  },
  { timestamps: true }
);

serviceSchema.index({ isActive: 1, name: 1 });
serviceSchema.index({ isActive: 1, serviceCategory: 1 });
serviceSchema.index({ availability: 1, serviceCategory: 1 });

module.exports = mongoose.model("Service", serviceSchema);
