const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  enabled: { type: Boolean, default: true },
  order: { type: Number, default: 0 }
}, { _id: false });

const serviceChecklistConfigSchema = new mongoose.Schema({
  serviceCategory: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
  serviceLabel: { type: String, required: true, trim: true },
  descriptionExample: { type: String, required: true, trim: true },
  tasks: { type: [taskSchema], default: [] },
  version: { type: Number, default: 1, min: 1 },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("ServiceChecklistConfig", serviceChecklistConfigSchema);
