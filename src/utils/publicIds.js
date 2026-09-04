const Sequence = require("../models/Sequence");

const FORMATS = Object.freeze({
  user: { prefix: "ASU", width: 5 },
  booking: { prefix: "ASB", width: 5 },
  partner: { prefix: "ASP", width: 5 },
  userComplaint: { prefix: "ASCU", width: 4 },
  partnerComplaint: { prefix: "ASCP", width: 5 },
  payment: { prefix: "ASPAY", width: 5 },
  userDevice: { prefix: "ASDU", width: 5 },
  partnerDevice: { prefix: "ASDP", width: 5 },
  invoice: { prefix: "INV-AS", width: 6 }
});

async function nextPublicId(kind) {
  const format = FORMATS[kind];
  if (!format) throw new Error(`Unknown public ID sequence: ${kind}`);
  const counter = await Sequence.findOneAndUpdate(
    { _id: kind },
    { $inc: { value: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `${format.prefix}${String(counter.value).padStart(format.width, "0")}`;
}

function publicIdPlugin(schema, options) {
  const field = options?.field || "publicId";
  schema.add({ [field]: { type: String, trim: true, unique: true, sparse: true, index: true } });
  schema.pre("validate", async function assignPublicId() {
    if (!this[field] && this.isNew) this[field] = await nextPublicId(typeof options.kind === "function" ? options.kind(this) : options.kind);
  });
  schema.post("findOneAndUpdate", async function assignUpsertedPublicId(document) {
    if (!document || document[field]) return;
    const value = await nextPublicId(typeof options.kind === "function" ? options.kind(document) : options.kind);
    await document.constructor.updateOne({ _id: document._id, [field]: { $in: [null, ""] } }, { $set: { [field]: value } });
    document[field] = value;
  });
}

module.exports = { FORMATS, nextPublicId, publicIdPlugin };
