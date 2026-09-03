const mongoose = require("mongoose");

const appControlItemSchema = new mongoose.Schema({
  // Content belongs to exactly one client application. Existing records without
  // this field are treated as customer records by the query helpers.
  app: { type: String, enum: ["customer", "partner"], default: "customer", index: true },
  kind: { type: String, enum: ["announcement", "banner"], required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, trim: true, default: "", maxlength: 1000 },
  imageUrl: { type: String, trim: true, default: "" },
  // Presentation fields are deliberately a small allow-list. Admins can make
  // campaign banners without the mobile app ever evaluating arbitrary markup.
  bannerStyle: {
    backgroundColor: { type: String, trim: true, default: "#161616" },
    overlayColor: { type: String, trim: true, default: "#000000" },
    overlayOpacity: { type: Number, min: 0, max: 0.9, default: 0.32 },
    titleColor: { type: String, trim: true, default: "#ffffff" },
    messageColor: { type: String, trim: true, default: "#ffffff" },
    ctaBackgroundColor: { type: String, trim: true, default: "#ffffff" },
    ctaTextColor: { type: String, trim: true, default: "#161616" },
    titleFont: { type: String, enum: ["system", "rounded", "serif", "monospaced"], default: "system" },
    titleWeight: { type: String, enum: ["regular", "semibold", "bold", "heavy"], default: "heavy" },
    titleSize: { type: Number, min: 16, max: 42, default: 28 },
    messageSize: { type: Number, min: 10, max: 24, default: 13 },
    textAlignment: { type: String, enum: ["leading", "center", "trailing"], default: "leading" }
  },
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

appControlItemSchema.index({ app: 1, kind: 1, status: 1, startsAt: 1, endsAt: 1, priority: 1 });

module.exports = mongoose.model("AppControlItem", appControlItemSchema);
