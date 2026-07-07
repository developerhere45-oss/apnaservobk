const mongoose = require("mongoose");

const employeeActivityLogSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    action: { type: String, trim: true, default: "" },
    module: { type: String, trim: true, default: "" },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" }
  },
  { timestamps: true }
);

employeeActivityLogSchema.index({ employeeId: 1, createdAt: -1 });
employeeActivityLogSchema.index({ module: 1, createdAt: -1 });

module.exports = mongoose.model("EmployeeActivityLog", employeeActivityLogSchema);
