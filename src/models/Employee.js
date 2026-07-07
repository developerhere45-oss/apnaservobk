const mongoose = require("mongoose");

const permissionsSchema = new mongoose.Schema(
  {
    viewDashboard: { type: Boolean, default: true },
    viewBookings: { type: Boolean, default: true },
    updateBookingStatus: { type: Boolean, default: false },
    viewPartners: { type: Boolean, default: true },
    approvePartners: { type: Boolean, default: false },
    viewUsers: { type: Boolean, default: true },
    handleChats: { type: Boolean, default: true },
    sendNotifications: { type: Boolean, default: false }
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    employeeId: { type: String, unique: true, sparse: true, trim: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true, default: "" },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["employee"], default: "employee", index: true },
    department: { type: String, enum: ["support", "operations", "verification", "general"], default: "general", index: true },
    permissions: { type: permissionsSchema, default: () => ({}) },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    lastLoginAt: { type: Date, default: null }
  },
  { timestamps: true }
);

employeeSchema.pre("validate", function assignEmployeeId(next) {
  if (!this.employeeId) {
    const random = Math.random().toString(36).slice(2, 7).toUpperCase();
    this.employeeId = `EMP-${Date.now().toString(36).toUpperCase()}-${random}`;
  }
  next();
});

employeeSchema.methods.toSafeJSON = function toSafeJSON() {
  const doc = this.toObject({ getters: true });
  delete doc.passwordHash;
  return {
    id: String(doc._id),
    employeeId: doc.employeeId,
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    role: doc.role,
    department: doc.department,
    permissions: doc.permissions || {},
    status: doc.status,
    lastLoginAt: doc.lastLoginAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
};

module.exports = mongoose.model("Employee", employeeSchema);
