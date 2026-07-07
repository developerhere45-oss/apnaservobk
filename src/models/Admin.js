const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["super_admin", "admin"], default: "admin", index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    lastLoginAt: { type: Date, default: null }
  },
  { timestamps: true }
);

adminSchema.methods.toSafeJSON = function toSafeJSON() {
  const doc = this.toObject({ getters: true });
  delete doc.passwordHash;
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    status: doc.status,
    lastLoginAt: doc.lastLoginAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
};

module.exports = mongoose.model("Admin", adminSchema);
