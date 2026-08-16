const mongoose = require("mongoose");

const featureRegistrySchema = new mongoose.Schema({
  featureId: { type: String, required: true, unique: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, default: "", maxlength: 500 },
  platform: { type: String, enum: ["all", "android", "ios"], default: "all" },
  minimumAppVersion: { type: String, trim: true, default: "" },
  dependencies: { type: [String], default: [] },
  implementationState: { type: String, enum: ["active", "implementation_not_found"], default: "active", index: true },
  discoveredBy: { type: String, trim: true, default: "source-audit" },
  lastDiscoveredAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("FeatureRegistry", featureRegistrySchema);
