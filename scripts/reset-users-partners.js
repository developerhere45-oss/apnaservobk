const path = require("node:path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const models = require("./db-models");

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const confirmed = args.has("--yes-new-start");

const resetPlan = [
  ["Booking messages", models.BookingMessage],
  ["Call logs", models.CallLog],
  ["Commission ledger", models.CommissionLedger],
  ["Customer no response reports", models.CustomerNoResponseReport],
  ["Fraud alerts", models.FraudAlert],
  ["In-app notifications", models.InAppNotification],
  ["Job proof photos", models.JobProofPhoto],
  ["Location logs", models.LocationLog],
  ["OTP challenges", models.OtpChallenge],
  ["Partner documents", models.PartnerDocument],
  ["Payments", models.Payment],
  ["Reviews", models.Review],
  ["Review disputes", models.ReviewDispute],
  ["Revisit requests", models.RevisitRequest],
  ["SMS delivery logs", models.SmsDeliveryLog],
  ["Support tickets", models.SupportTicket],
  ["Technician SOS", models.TechnicianSos],
  ["Bookings", models.Booking],
  ["Admin notifications", models.AdminNotification],
  ["Admin activity", models.AdminActivity],
  ["Partners", models.Partner],
  ["Users", models.User],
];

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 8000),
  });
}

async function main() {
  if (apply && !confirmed) {
    throw new Error("Refusing destructive reset without --yes-new-start");
  }

  await connect();
  const output = [];
  for (const [label, model] of resetPlan) {
    const count = await model.countDocuments();
    let deleted = 0;
    if (apply && count > 0) {
      const result = await model.deleteMany({});
      deleted = result.deletedCount || 0;
    }
    output.push({ collection: label, count, deleted });
  }

  console.table(output);
  console.log(apply ? "RESET APPLIED" : "DRY RUN ONLY. Add --apply --yes-new-start to delete.");
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
