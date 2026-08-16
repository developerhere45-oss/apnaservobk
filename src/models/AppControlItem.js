const mongoose = require("mongoose");

const appControlItemSchema = new mongoose.Schema({
  kind: { type: String, enum: ["announcement", "banner"], required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, trim: true, default: "", maxlength: 1000 },
  imageUrl: { type: String, trim: true, default: "" },
  ctaText: { type: String, trim: true, default: "", maxlength: 40 },
  ctaAction: { type: String, trim: true, default: "" },
  serviceCategory: { type: String, trim: true, default: "", index: true },
  placement: { type: String, trim: true, default: "home_top", index: true },
  priority: { type: Number, min: 0, max: 9999, default: 100, index: true },
  audience: { type: String, enum: ["all", "users", "partners"], default: "all", index: true },
  status: { type: String, enum: ["draft", "scheduled", "published", "disabled", "expired"], default: "draft", index: true },
  startsAt: { type: Date, default: null, index: true },
  endsAt: { type: Date, default: null, index: true },
  createdBy: { type: String, trim: true, default: "" },
  updatedBy: { type: String, trim: true, default: "" }
}, { timestamps: true });

appControlItemSchema.index({ kind: 1, status: 1, startsAt: 1, endsAt: 1, priority: 1 });

module.exports = mongoose.model("AppControlItem", appControlItemSchema);
