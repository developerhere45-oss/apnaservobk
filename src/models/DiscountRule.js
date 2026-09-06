const mongoose = require("mongoose");

const discountRuleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  serviceCategory: { type: String, required: true, trim: true, lowercase: true, index: true },
  audience: { type: String, enum: ["all", "new_users", "individual"], default: "new_users", index: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  discountType: { type: String, enum: ["fixed", "percent"], default: "fixed" },
  value: { type: Number, required: true, min: 0 },
  maxDiscount: { type: Number, default: 0, min: 0 },
  minimumAmount: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true, index: true },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  createdBy: { type: String, default: "admin" }
}, { timestamps: true });

discountRuleSchema.index({ serviceCategory: 1, audience: 1, active: 1, startsAt: 1, endsAt: 1 });
module.exports = mongoose.model("DiscountRule", discountRuleSchema);
