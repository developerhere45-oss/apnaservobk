const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema(
  {
    serviceCategory: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    basePrice: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

serviceSchema.index({ isActive: 1, name: 1 });
serviceSchema.index({ isActive: 1, serviceCategory: 1 });

module.exports = mongoose.model("Service", serviceSchema);
