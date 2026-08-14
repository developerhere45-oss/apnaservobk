const mongoose = require("mongoose");

const sequenceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  value: { type: Number, required: true, default: 0 }
}, { versionKey: false, timestamps: true });

module.exports = mongoose.model("Sequence", sequenceSchema);
