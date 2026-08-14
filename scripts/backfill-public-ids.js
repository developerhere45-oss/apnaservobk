require("dotenv").config();
const mongoose = require("mongoose");
const Sequence = require("../src/models/Sequence");
const User = require("../src/models/User");
const Partner = require("../src/models/Partner");
const { Booking } = require("../src/models/Booking");
const SupportTicket = require("../src/models/SupportTicket");
const Payment = require("../src/models/Payment");
const { FORMATS, nextPublicId } = require("../src/utils/publicIds");

const apply = process.argv.includes("--apply");

function numericPart(value, prefix) {
  const match = String(value || "").match(new RegExp(`^${prefix}(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

async function syncCounter(kind, values) {
  const { prefix } = FORMATS[kind];
  const maximum = values.reduce((max, value) => Math.max(max, numericPart(value, prefix)), 0);
  if (apply && maximum) await Sequence.updateOne({ _id: kind }, { $max: { value: maximum } }, { upsert: true });
}

async function backfillCollection(Model, kind, field = "publicId", typeFilter = null) {
  const filter = typeFilter || {};
  const existing = await Model.find(filter, { [field]: 1 }).lean();
  await syncCounter(kind, existing.map((row) => row[field]));
  const missing = existing.filter((row) => !row[field]);
  if (apply) {
    for (const row of missing) {
      const value = await nextPublicId(kind);
      await Model.updateOne({ _id: row._id, [field]: { $in: [null, ""] } }, { $set: { [field]: value } });
    }
  }
  return { kind, total: existing.length, missing: missing.length };
}

async function backfillDevices(Model, kind) {
  const owners = await Model.find({ $or: [{ "deviceTokens.0": { $exists: true } }, { fcmToken: { $nin: [null, ""] } }] }, { deviceTokens: 1, fcmToken: 1, legacyDevicePublicId: 1 }).lean();
  const current = owners.flatMap((owner) => [...(owner.deviceTokens || []).map((device) => device.publicId), owner.legacyDevicePublicId]);
  await syncCounter(kind, current);
  let missing = 0;
  for (const owner of owners) {
    if (owner.fcmToken && !owner.legacyDevicePublicId) {
      missing += 1;
      if (apply) await Model.updateOne({ _id: owner._id, legacyDevicePublicId: { $in: [null, ""] } }, { $set: { legacyDevicePublicId: await nextPublicId(kind) } });
    }
    for (const device of owner.deviceTokens || []) {
      if (device.publicId) continue;
      missing += 1;
      if (apply) {
        const value = await nextPublicId(kind);
        await Model.updateOne({ _id: owner._id, "deviceTokens._id": device._id }, { $set: { "deviceTokens.$.publicId": value } });
      }
    }
  }
  return { kind, total: current.length, missing };
}

async function main() {
  const mongoUri = String(process.env.MONGODB_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(mongoUri);
  const reports = [];
  reports.push(await backfillCollection(User, "user"));
  reports.push(await backfillCollection(Booking, "booking"));
  reports.push(await backfillCollection(Partner, "partner"));
  reports.push(await backfillCollection(SupportTicket, "userComplaint", "publicId", { partnerId: null, source: { $ne: "partner_app" } }));
  reports.push(await backfillCollection(SupportTicket, "partnerComplaint", "publicId", { $or: [{ partnerId: { $ne: null } }, { source: "partner_app" }] }));
  reports.push(await backfillCollection(Payment, "payment"));
  reports.push(await backfillDevices(User, "userDevice"));
  reports.push(await backfillDevices(Partner, "partnerDevice"));
  console.table(reports);
  console.log(apply ? "Public ID backfill applied." : "Dry run only. Re-run with --apply after reviewing counts.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
