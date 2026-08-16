const mongoose = require("mongoose");

const appControlConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "customer-app", index: true },
  draft: { type: mongoose.Schema.Types.Mixed, default: {} },
  published: { type: mongoose.Schema.Types.Mixed, default: {} },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: String, trim: true, default: "" },
  version: { type: Number, default: 0 },
  updatedBy: { type: String, trim: true, default: "" }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model("AppControlConfig", appControlConfigSchema);
