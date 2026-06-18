const path = require("node:path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const models = require("./db-models");
const { pendingAssignmentStatuses } = require("../src/utils/bookingLifecycle");

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const applyIndexes = args.has("--apply-indexes") || apply;
const fixIndexConflicts = args.has("--fix-index-conflicts");
const rebuildPartnerStats = args.has("--rebuild-partner-stats");
const dryRun = !apply;

function moneyValue(booking) {
  return Math.round(Number(booking.finalAmount || booking.price || 0));
}

function commissionRate() {
  const value = Number(process.env.APP_COMMISSION_RATE || 0.1);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.1;
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 8000)
  });
}

async function count(model, filter) {
  return model.countDocuments(filter);
}

async function plannedUpdateMany(actions, name, model, filter, update, options = {}) {
  const matched = await count(model, filter);
  let modified = 0;
  if (apply && matched > 0) {
    const result = await model.updateMany(filter, update, options);
    modified = result.modifiedCount || result.nModified || 0;
  }
  actions.push({ name, matched, modified, applied: apply });
}

async function plannedCollectionUpdateMany(actions, name, collection, filter, update) {
  const matched = await collection.countDocuments(filter);
  let modified = 0;
  if (apply && matched > 0) {
    const result = await collection.updateMany(filter, update);
    modified = result.modifiedCount || 0;
  }
  actions.push({ name, matched, modified, applied: apply });
}

async function syncAdditiveIndexes(actions) {
  if (!applyIndexes) {
    actions.push({ name: "create additive indexes", matched: 0, modified: 0, applied: false, note: "pass --apply-indexes or --apply" });
    return;
  }
  await repairUniqueIndexConflicts(actions);
  for (const [name, model] of Object.entries(models)) {
    try {
      await model.createIndexes();
      actions.push({ name: `create indexes for ${name}`, matched: 1, modified: 1, applied: true });
    } catch (error) {
      actions.push({
        name: `create indexes for ${name}`,
        matched: 1,
        modified: 0,
        applied: false,
        note: error.message
      });
    }
  }
}

async function duplicateGroupCount(model, field, match = {}) {
  const [result] = await model.aggregate([
    { $match: { [field]: { $exists: true, $nin: [null, ""] }, ...match } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "count" }
  ]);
  return result?.count || 0;
}

async function repairUniqueIndexConflicts(actions) {
  const repairs = [
    { modelName: "Review", field: "bookingId", keys: { bookingId: 1 }, indexName: "bookingId_1" },
    { modelName: "CommissionLedger", field: "bookingId", keys: { bookingId: 1 }, indexName: "bookingId_1" },
    {
      modelName: "Partner",
      field: "phoneHash",
      keys: { phoneHash: 1 },
      indexName: "phoneHash_1",
      options: { unique: true, background: true, name: "phoneHash_1", partialFilterExpression: { phoneHash: { $type: "string", $gt: "" } } }
    },
    {
      modelName: "Partner",
      field: "emailHash",
      keys: { emailHash: 1 },
      indexName: "emailHash_1",
      options: { unique: true, background: true, name: "emailHash_1", partialFilterExpression: { emailHash: { $type: "string", $gt: "" } } }
    }
  ];

  for (const repair of repairs) {
    const model = models[repair.modelName];
    const indexes = await model.collection.indexes();
    const index = indexes.find((item) => item.name === repair.indexName && JSON.stringify(item.key) === JSON.stringify(repair.keys));
    if (!index || index.unique) {
      continue;
    }
    const duplicateCount = await duplicateGroupCount(model, repair.field, repair.match || {});
    if (duplicateCount > 0) {
      actions.push({
        name: `repair unique index conflict for ${repair.modelName}.${repair.field}`,
        matched: duplicateCount,
        modified: 0,
        applied: false,
        note: "duplicates exist; merge duplicates before creating unique index"
      });
      continue;
    }
    if (!fixIndexConflicts) {
      actions.push({
        name: `repair unique index conflict for ${repair.modelName}.${repair.field}`,
        matched: 1,
        modified: 0,
        applied: false,
        note: "pass --fix-index-conflicts after confirming duplicate audit is clean"
      });
      continue;
    }
    await model.collection.dropIndex(repair.indexName);
    await model.collection.createIndex(repair.keys, repair.options || { unique: true, background: true, name: repair.indexName });
    actions.push({
      name: `repair unique index conflict for ${repair.modelName}.${repair.field}`,
      matched: 1,
      modified: 1,
      applied: true
    });
  }
}

async function upsertCommissionLedgers(actions) {
  const cursor = models.Booking.find({
    status: "completed",
    partnerId: { $ne: null },
    userId: { $ne: null }
  }).cursor();
  let matched = 0;
  let modified = 0;
  const rate = commissionRate();

  for await (const booking of cursor) {
    const existing = await models.CommissionLedger.findOne({ bookingId: booking._id }, { _id: 1 }).lean();
    if (existing) continue;
    matched += 1;
    if (!apply) continue;

    const grossAmount = moneyValue(booking);
    const commissionAmount = Math.round(grossAmount * rate);
    await models.CommissionLedger.create({
      bookingId: booking._id,
      bookingCode: booking.bookingCode,
      partnerId: booking.partnerId,
      userId: booking.userId,
      grossAmount,
      commissionRate: rate,
      commissionAmount,
      netPayable: Math.max(0, grossAmount - commissionAmount),
      status: "pending",
      source: "booking_completion",
      completedAt: booking.completedAt || booking.updatedAt || booking.createdAt || new Date()
    });
    modified += 1;
  }

  actions.push({ name: "upsert missing commission ledgers", matched, modified, applied: apply });
}

async function rebuildProofSummaries(actions) {
  const summaries = await models.JobProofPhoto.aggregate([
    {
      $group: {
        _id: { bookingId: "$bookingId", stage: "$stage" },
        count: { $sum: 1 },
        lastUploadedAt: { $max: "$createdAt" }
      }
    },
    {
      $group: {
        _id: "$_id.bookingId",
        beforeCount: { $sum: { $cond: [{ $eq: ["$_id.stage", "before"] }, "$count", 0] } },
        afterCount: { $sum: { $cond: [{ $eq: ["$_id.stage", "after"] }, "$count", 0] } },
        lastUploadedAt: { $max: "$lastUploadedAt" }
      }
    }
  ]).allowDiskUse(true);

  let modified = 0;
  if (apply) {
    for (const summary of summaries) {
      const result = await models.Booking.updateOne(
        { _id: summary._id },
        {
          $set: {
            "proofSummary.beforeCount": summary.beforeCount || 0,
            "proofSummary.afterCount": summary.afterCount || 0,
            "proofSummary.lastUploadedAt": summary.lastUploadedAt || null
          }
        }
      );
      modified += result.modifiedCount || 0;
    }
  }
  actions.push({ name: "rebuild booking proof summaries", matched: summaries.length, modified, applied: apply });
}

async function rebuildReviewSnapshots(actions) {
  const reviews = await models.Review.find({}, {
    _id: 1,
    bookingId: 1,
    rating: 1,
    status: 1,
    disputeStatus: 1,
    createdAt: 1
  }).lean();
  let modified = 0;
  if (apply) {
    for (const review of reviews) {
      const result = await models.Booking.updateOne(
        { _id: review.bookingId },
        {
          $set: {
            "reviewSnapshot.reviewId": review._id,
            "reviewSnapshot.rating": review.rating,
            "reviewSnapshot.status": review.status,
            "reviewSnapshot.disputeStatus": review.disputeStatus,
            "reviewSnapshot.reviewedAt": review.createdAt || new Date()
          }
        }
      );
      modified += result.modifiedCount || 0;
    }
  }
  actions.push({ name: "rebuild booking review snapshots", matched: reviews.length, modified, applied: apply });
}

async function rebuildPartnerEarnings(actions) {
  if (!rebuildPartnerStats) {
    actions.push({
      name: "rebuild partner totalJobs/earnings",
      matched: 0,
      modified: 0,
      applied: false,
      note: "pass --rebuild-partner-stats with --apply after reviewing commission policy"
    });
    return;
  }

  const aggregates = await models.Booking.aggregate([
    { $match: { status: "completed", partnerId: { $ne: null } } },
    {
      $group: {
        _id: "$partnerId",
        totalJobs: { $sum: 1 },
        earnings: { $sum: { $cond: [{ $gt: ["$finalAmount", 0] }, "$finalAmount", "$price"] } }
      }
    }
  ]).allowDiskUse(true);

  let modified = 0;
  if (apply) {
    for (const item of aggregates) {
      const result = await models.Partner.updateOne(
        { _id: item._id },
        { $set: { totalJobs: item.totalJobs || 0, earnings: Math.round(item.earnings || 0) } }
      );
      modified += result.modifiedCount || 0;
    }
  }
  actions.push({ name: "rebuild partner totalJobs/earnings", matched: aggregates.length, modified, applied: apply });
}

async function run() {
  await connect();
  const actions = [];
  const now = new Date();
  const quoteExpiredAt = new Date();
  const quoteRepairExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await syncAdditiveIndexes(actions);

  await plannedUpdateMany(
    actions,
    "expire old pending quotes",
    models.Booking,
    { status: "amount_pending", quoteStatus: "pending", quoteExpiresAt: { $lte: quoteExpiredAt } },
    {
      $set: { status: "started", quoteStatus: "expired", paymentStatus: "pending" },
      $push: {
        statusTimeline: { status: "quote_expired", at: now, by: "system_migration" },
        quoteHistory: {
          kind: "quote_expired",
          amount: 0,
          by: "system_migration",
          message: "Quote expired during database migration",
          at: now
        }
      }
    }
  );

  await plannedUpdateMany(
    actions,
    "normalize pending bookings that already have partnerId",
    models.Booking,
    { status: { $in: pendingAssignmentStatuses() }, partnerId: { $ne: null } },
    {
      $set: { status: "accepted" },
      $push: { statusTimeline: { status: "accepted_by_migration", at: now, by: "system_migration" } }
    }
  );

  await plannedUpdateMany(
    actions,
    "repair amount_pending bookings with missing quote status",
    models.Booking,
    { status: "amount_pending", quoteStatus: { $nin: ["pending", "countered"] } },
    {
      $set: {
        quoteStatus: "pending",
        quoteRequestedAt: now,
        quoteExpiresAt: quoteRepairExpiresAt,
        paymentStatus: "pending"
      },
      $push: { statusTimeline: { status: "quote_status_repaired", at: now, by: "system_migration" } }
    }
  );

  await plannedCollectionUpdateMany(
    actions,
    "set completedAt on completed bookings",
    models.Booking.collection,
    { status: "completed", completedAt: null },
    [
      {
        $set: {
          completedAt: { $ifNull: ["$updatedAt", "$createdAt"] }
        }
      }
    ]
  );

  await plannedUpdateMany(
    actions,
    "normalize completed booking payment and quote status",
    models.Booking,
    { status: "completed", $or: [{ paymentStatus: { $ne: "paid" } }, { quoteStatus: { $ne: "approved" } }] },
    { $set: { paymentStatus: "paid", quoteStatus: "approved" } }
  );

  await plannedCollectionUpdateMany(
    actions,
    "set missing completion accounting",
    models.Booking.collection,
    {
      status: "completed",
      $or: [
        { "completionAccounting.creditedAt": null },
        { "completionAccounting.creditedAt": { $exists: false } }
      ]
    },
    [
      {
        $set: {
          "completionAccounting.creditedAt": { $ifNull: ["$completedAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
          "completionAccounting.grossAmount": {
            $round: [
              { $cond: [{ $gt: ["$finalAmount", 0] }, "$finalAmount", "$price"] },
              0
            ]
          }
        }
      }
    ]
  );

  await plannedUpdateMany(
    actions,
    "clear negative booking amounts",
    models.Booking,
    { $or: [{ price: { $lt: 0 } }, { finalAmount: { $lt: 0 } }, { quoteAmount: { $lt: 0 } }] },
    { $max: { price: 0, finalAmount: 0, quoteAmount: 0 } }
  );

  await upsertCommissionLedgers(actions);
  await rebuildProofSummaries(actions);
  await rebuildReviewSnapshots(actions);
  await rebuildPartnerEarnings(actions);

  const mode = apply
    ? "Database migration applied."
    : applyIndexes
      ? "Database index migration complete; data fixes were dry-run only."
      : "Database migration dry-run complete.";
  console.log(mode);
  console.table(actions.map((action) => ({
    action: action.name,
    matched: action.matched,
    modified: action.modified,
    applied: action.applied,
    note: action.note || ""
  })));

  await mongoose.disconnect();
}

run().catch(async (error) => {
  await mongoose.disconnect().catch(() => {});
  console.error(`Database migration failed: ${error.message}`);
  process.exit(1);
});
