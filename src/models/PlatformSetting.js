const mongoose = require("mongoose");

const platformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: String, trim: true, default: "system" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("PlatformSetting", platformSettingSchema);
