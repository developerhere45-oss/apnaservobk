const mongoose = require("mongoose");

const featureRegistrySchema = new mongoose.Schema({
  app: { type: String, enum: ["customer", "partner"], default: "customer", index: true },
  featureId: { type: String, required: true, unique: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, default: "", maxlength: 500 },
  platform: { type: String, enum: ["all", "android", "ios"], default: "all" },
  minimumAppVersion: { type: String, trim: true, default: "" },
  dependencies: { type: [String], default: [] },
  implementationState: { type: String, enum: ["active", "implementation_not_found"], default: "active", index: true },
  // A real source feature may exist before its mobile client has added the
  // remote-config check. It is listed honestly but cannot be toggled yet.
  remoteConfigSupported: { type: Boolean, default: false },
  discoveredBy: { type: String, trim: true, default: "source-audit" },
  lastDiscoveredAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("FeatureRegistry", featureRegistrySchema);
