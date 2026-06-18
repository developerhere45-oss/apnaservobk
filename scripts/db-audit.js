const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const models = require("./db-models");
const {
  BOOKING_STATUSES,
  activeJobStatuses,
  pendingAssignmentStatuses
} = require("../src/utils/bookingLifecycle");

const args = new Set(process.argv.slice(2));
const schemaOnly = args.has("--schema-only");
const failOnIssues = args.has("--fail-on-issues");
const outputPath = valueAfter("--out") || path.resolve(__dirname, "../database-audit-report.json");

const expectedIndexes = [
  { model: "Booking", keys: { bookingCode: 1 }, unique: true, reason: "idempotent booking creation" },
  { model: "Booking", keys: { userId: 1, createdAt: -1 }, reason: "customer booking history" },
  { model: "Booking", keys: { partnerId: 1, createdAt: -1 }, reason: "partner booking history" },
  { model: "Booking", keys: { partnerId: 1, status: 1, updatedAt: -1 }, reason: "partner active jobs" },
  { model: "Booking", keys: { status: 1, serviceCategory: 1, createdAt: -1 }, reason: "open job feed" },
  { model: "Booking", keys: { requestedPartners: 1, status: 1, createdAt: -1 }, reason: "push/retry assignment feed" },
  { model: "Booking", keys: { quoteStatus: 1, quoteExpiresAt: 1 }, reason: "quote expiry sweep" },
  { model: "Booking", keys: { "completionAccounting.creditedAt": 1, status: 1 }, reason: "one-time completion accounting" },
  { model: "BookingMessage", keys: { bookingId: 1, createdAt: 1 }, reason: "chat pagination" },
  { model: "BookingMessage", keys: { bookingId: 1, senderRole: 1, clientMessageId: 1 }, unique: true, reason: "idempotent chat send" },
  { model: "InAppNotification", keys: { userId: 1, readAt: 1, createdAt: -1 }, reason: "user notifications" },
  { model: "InAppNotification", keys: { partnerId: 1, readAt: 1, createdAt: -1 }, reason: "partner notifications" },
  { model: "LocationLog", keys: { bookingId: 1, partnerId: 1, validationStatus: 1, recordedAt: -1 }, reason: "live tracking latest location" },
  { model: "Payment", keys: { bookingId: 1, userId: 1, createdAt: -1 }, reason: "latest payment lookup" },
  { model: "Payment", keys: { status: 1, createdAt: -1 }, reason: "payment operations queue" },
  { model: "Review", keys: { bookingId: 1 }, unique: true, reason: "one review per completed booking" },
  { model: "CommissionLedger", keys: { bookingId: 1 }, unique: true, reason: "one commission ledger per completed booking" },
  { model: "Partner", keys: { location: "2dsphere" }, reason: "nearby partner search" },
  { model: "Partner", keys: { serviceCategory: 1, isOnline: 1, isVerified: 1, trustStatus: 1, city: 1 }, reason: "partner matching fallback" },
  { model: "PartnerDocument", keys: { partnerId: 1, documentType: 1, validationStatus: 1, createdAt: -1 }, reason: "KYC review" },
  { model: "FraudAlert", keys: { status: 1, severity: 1, createdAt: -1 }, reason: "admin fraud queue" }
];

const relationChecks = [
  ["Booking.userId", "Booking", "userId", "User"],
  ["Booking.partnerId", "Booking", "partnerId", "Partner"],
  ["Booking.reviewSnapshot.reviewId", "Booking", "reviewSnapshot.reviewId", "Review"],
  ["BookingMessage.bookingId", "BookingMessage", "bookingId", "Booking"],
  ["BookingMessage.userId", "BookingMessage", "userId", "User"],
  ["BookingMessage.partnerId", "BookingMessage", "partnerId", "Partner"],
  ["CallLog.bookingId", "CallLog", "bookingId", "Booking"],
  ["CallLog.userId", "CallLog", "userId", "User"],
  ["CallLog.partnerId", "CallLog", "partnerId", "Partner"],
  ["CommissionLedger.bookingId", "CommissionLedger", "bookingId", "Booking"],
  ["CommissionLedger.userId", "CommissionLedger", "userId", "User"],
  ["CommissionLedger.partnerId", "CommissionLedger", "partnerId", "Partner"],
  ["CustomerNoResponseReport.bookingId", "CustomerNoResponseReport", "bookingId", "Booking"],
  ["CustomerNoResponseReport.userId", "CustomerNoResponseReport", "userId", "User"],
  ["CustomerNoResponseReport.partnerId", "CustomerNoResponseReport", "partnerId", "Partner"],
  ["FraudAlert.bookingId", "FraudAlert", "bookingId", "Booking"],
  ["FraudAlert.userId", "FraudAlert", "userId", "User"],
  ["FraudAlert.partnerId", "FraudAlert", "partnerId", "Partner"],
  ["InAppNotification.bookingId", "InAppNotification", "bookingId", "Booking"],
  ["InAppNotification.userId", "InAppNotification", "userId", "User"],
  ["InAppNotification.partnerId", "InAppNotification", "partnerId", "Partner"],
  ["JobProofPhoto.bookingId", "JobProofPhoto", "bookingId", "Booking"],
  ["JobProofPhoto.userId", "JobProofPhoto", "userId", "User"],
  ["JobProofPhoto.partnerId", "JobProofPhoto", "partnerId", "Partner"],
  ["LocationLog.bookingId", "LocationLog", "bookingId", "Booking"],
  ["LocationLog.partnerId", "LocationLog", "partnerId", "Partner"],
  ["PartnerDocument.partnerId", "PartnerDocument", "partnerId", "Partner"],
  ["Payment.bookingId", "Payment", "bookingId", "Booking"],
  ["Payment.userId", "Payment", "userId", "User"],
  ["Payment.partnerId", "Payment", "partnerId", "Partner"],
  ["Review.bookingId", "Review", "bookingId", "Booking"],
  ["Review.userId", "Review", "userId", "User"],
  ["Review.partnerId", "Review", "partnerId", "Partner"],
  ["ReviewDispute.reviewId", "ReviewDispute", "reviewId", "Review"],
  ["ReviewDispute.bookingId", "ReviewDispute", "bookingId", "Booking"],
  ["ReviewDispute.userId", "ReviewDispute", "userId", "User"],
  ["ReviewDispute.partnerId", "ReviewDispute", "partnerId", "Partner"],
  ["RevisitRequest.bookingId", "RevisitRequest", "bookingId", "Booking"],
  ["RevisitRequest.userId", "RevisitRequest", "userId", "User"],
  ["RevisitRequest.partnerId", "RevisitRequest", "partnerId", "Partner"],
  ["SmsDeliveryLog.notificationId", "SmsDeliveryLog", "notificationId", "InAppNotification"],
  ["SmsDeliveryLog.userId", "SmsDeliveryLog", "userId", "User"],
  ["SmsDeliveryLog.partnerId", "SmsDeliveryLog", "partnerId", "Partner"],
  ["TechnicianSos.bookingId", "TechnicianSos", "bookingId", "Booking"],
  ["TechnicianSos.userId", "TechnicianSos", "userId", "User"],
  ["TechnicianSos.partnerId", "TechnicianSos", "partnerId", "Partner"]
];

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

function orderedJson(value) {
  return JSON.stringify(value);
}

function sameKeys(left, right) {
  return orderedJson(left) === orderedJson(right);
}

function schemaIndexSpecs(model) {
  return model.schema.indexes().map(([keys, options]) => ({ keys, options: options || {} }));
}

async function databaseIndexSpecs(model) {
  const indexes = await model.collection.indexes();
  return indexes.map((index) => ({ keys: index.key, options: index }));
}

function redactUri(uri) {
  return String(uri || "").replace(/\/\/([^:/?#]+):([^@]+)@/, "//***:***@");
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required unless --schema-only is used");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 8000)
  });
}

async function relationAudit(name, modelName, field, targetName) {
  const model = models[modelName];
  const target = models[targetName];
  const fieldExists = { [field]: { $exists: true, $ne: null } };
  const pipeline = [
    { $match: fieldExists },
    {
      $lookup: {
        from: target.collection.name,
        localField: field,
        foreignField: "_id",
        as: "_target"
      }
    },
    { $match: { _target: { $eq: [] } } },
    {
      $facet: {
        count: [{ $count: "count" }],
        sample: [
          { $project: { _id: 1, bookingCode: 1, fieldValue: `$${field}` } },
          { $limit: 20 }
        ]
      }
    }
  ];
  const [result] = await model.aggregate(pipeline).allowDiskUse(true);
  return {
    name,
    model: modelName,
    field,
    target: targetName,
    count: result?.count?.[0]?.count || 0,
    sample: result?.sample || []
  };
}

async function duplicateAudit(name, modelName, match, groupId) {
  const model = models[modelName];
  const [result] = await model.aggregate([
    { $match: match },
    { $group: { _id: groupId, count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    {
      $facet: {
        count: [{ $count: "count" }],
        sample: [{ $project: { _id: 1, count: 1, ids: { $slice: ["$ids", 10] } } }, { $limit: 20 }]
      }
    }
  ]).allowDiskUse(true);
  return {
    name,
    model: modelName,
    count: result?.count?.[0]?.count || 0,
    sample: result?.sample || []
  };
}

async function queryCount(name, modelName, query) {
  const model = models[modelName];
  const count = await model.countDocuments(query);
  const sample = await model.find(query, { _id: 1, bookingCode: 1, status: 1, userId: 1, partnerId: 1 })
    .limit(20)
    .lean();
  return { name, model: modelName, count, sample };
}

function winningPlanIndexes(plan, found = []) {
  if (!plan || typeof plan !== "object") return found;
  if (plan.indexName) found.push(plan.indexName);
  for (const value of Object.values(plan)) {
    if (Array.isArray(value)) {
      value.forEach((item) => winningPlanIndexes(item, found));
    } else if (value && typeof value === "object") {
      winningPlanIndexes(value, found);
    }
  }
  return found;
}

async function explainQuery(name, queryFactory) {
  try {
    const plan = await queryFactory().explain("executionStats");
    const stats = plan.executionStats || {};
    const indexes = [...new Set(winningPlanIndexes(plan.queryPlanner?.winningPlan || {}))];
    const docsExamined = Number(stats.totalDocsExamined || 0);
    const returned = Number(stats.nReturned || 0);
    return {
      name,
      ok: docsExamined <= Math.max(1000, returned * 50 + 50),
      executionTimeMillis: stats.executionTimeMillis || 0,
      nReturned: returned,
      totalDocsExamined: docsExamined,
      indexes,
      warning: docsExamined > Math.max(1000, returned * 50 + 50)
        ? "High docs examined. Confirm index use before launch."
        : ""
    };
  } catch (error) {
    return { name, ok: false, error: error.message };
  }
}

async function runSlowQueryAudit() {
  const output = [];
  const [user, partner, booking, chatBooking, notificationUser] = await Promise.all([
    models.User.findOne({}, { _id: 1 }).lean(),
    models.Partner.findOne({}, { _id: 1, serviceCategory: 1 }).lean(),
    models.Booking.findOne({}, { _id: 1, userId: 1, partnerId: 1, serviceCategory: 1 }).lean(),
    models.BookingMessage.findOne({}, { bookingId: 1 }).lean(),
    models.InAppNotification.findOne({ userId: { $ne: null } }, { userId: 1 }).lean()
  ]);

  if (user) {
    output.push(await explainQuery("customer booking history", () =>
      models.Booking.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean()
    ));
  }
  if (partner) {
    output.push(await explainQuery("partner assigned booking history", () =>
      models.Booking.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(80).lean()
    ));
    const categories = partner.serviceCategory || [];
    if (categories.length) {
      output.push(await explainQuery("open booking feed by service", () =>
        models.Booking.find({
          status: { $in: pendingAssignmentStatuses() },
          serviceCategory: { $in: categories },
          rejectedPartners: { $ne: partner._id }
        }).sort({ createdAt: -1 }).limit(80).lean()
      ));
    }
  }
  if (chatBooking) {
    output.push(await explainQuery("chat message pagination", () =>
      models.BookingMessage.find({ bookingId: chatBooking.bookingId }).sort({ createdAt: -1 }).limit(80).lean()
    ));
  }
  if (notificationUser) {
    output.push(await explainQuery("notification list", () =>
      models.InAppNotification.find({ userId: notificationUser.userId }).sort({ createdAt: -1 }).limit(50).lean()
    ));
  }
  if (booking?.partnerId) {
    output.push(await explainQuery("live tracking latest location", () =>
      models.LocationLog.find({
        bookingId: booking._id,
        partnerId: booking.partnerId,
        validationStatus: "accepted"
      }).sort({ recordedAt: -1 }).limit(20).lean()
    ));
  }
  return output;
}

async function auditIndexes(fromDatabase) {
  const output = [];
  const cache = new Map();
  for (const expected of expectedIndexes) {
    const model = models[expected.model];
    if (!cache.has(expected.model)) {
      cache.set(expected.model, fromDatabase ? await databaseIndexSpecs(model) : schemaIndexSpecs(model));
    }
    const specs = cache.get(expected.model);
    const match = specs.find((spec) => sameKeys(spec.keys, expected.keys));
    output.push({
      ...expected,
      present: Boolean(match),
      uniquePresent: expected.unique ? Boolean(match?.options?.unique) : undefined
    });
  }
  return output;
}

async function runAudit() {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: schemaOnly ? "schema-only" : "database",
    database: schemaOnly ? "" : redactUri(process.env.MONGODB_URI),
    summary: {},
    indexes: [],
    relations: [],
    duplicates: [],
    stateConsistency: [],
    slowQueries: [],
    recommendations: []
  };

  if (schemaOnly) {
    report.indexes = await auditIndexes(false);
    report.summary.missingSchemaIndexes = report.indexes.filter((index) => !index.present).length;
    report.recommendations.push("Run without --schema-only against MongoDB Atlas before launch for full data checks.");
    return report;
  }

  await connect();

  report.indexes = await auditIndexes(true);
  report.relations = await Promise.all(relationChecks.map((check) => relationAudit(...check)));
  report.duplicates = await Promise.all([
    duplicateAudit("duplicate user firebaseUid", "User", { firebaseUid: { $exists: true, $ne: "" } }, "$firebaseUid"),
    duplicateAudit("duplicate partner firebaseUid", "Partner", { firebaseUid: { $exists: true, $ne: "" } }, "$firebaseUid"),
    duplicateAudit("duplicate partnerCode", "Partner", { partnerCode: { $exists: true, $ne: "" } }, "$partnerCode"),
    duplicateAudit("duplicate bookingCode", "Booking", { bookingCode: { $exists: true, $ne: "" } }, "$bookingCode"),
    duplicateAudit("duplicate serviceCategory", "Service", { serviceCategory: { $exists: true, $ne: "" } }, "$serviceCategory"),
    duplicateAudit("duplicate review for booking", "Review", { bookingId: { $exists: true, $ne: null } }, "$bookingId"),
    duplicateAudit("duplicate commission ledger for booking", "CommissionLedger", { bookingId: { $exists: true, $ne: null } }, "$bookingId"),
    duplicateAudit(
      "duplicate chat clientMessageId",
      "BookingMessage",
      { clientMessageId: { $exists: true, $type: "string", $ne: "" } },
      { bookingId: "$bookingId", senderRole: "$senderRole", clientMessageId: "$clientMessageId" }
    )
  ]);

  report.stateConsistency = await Promise.all([
    queryCount("booking status outside lifecycle enum", "Booking", { status: { $nin: BOOKING_STATUSES } }),
    queryCount("active booking missing partnerId", "Booking", {
      status: { $in: activeJobStatuses() },
      $or: [{ partnerId: null }, { partnerId: { $exists: false } }]
    }),
    queryCount("pending booking already has partnerId", "Booking", {
      status: { $in: pendingAssignmentStatuses() },
      partnerId: { $ne: null }
    }),
    queryCount("completed booking missing completedAt", "Booking", { status: "completed", completedAt: null }),
    queryCount("completed booking not marked paid", "Booking", { status: "completed", paymentStatus: { $ne: "paid" } }),
    queryCount("completed booking missing completion accounting", "Booking", {
      status: "completed",
      $or: [
        { "completionAccounting.creditedAt": null },
        { "completionAccounting.creditedAt": { $exists: false } }
      ]
    }),
    queryCount("amount pending booking has invalid quote status", "Booking", {
      status: "amount_pending",
      quoteStatus: { $nin: ["pending", "countered"] }
    }),
    queryCount("expired quote still pending", "Booking", {
      status: "amount_pending",
      quoteStatus: "pending",
      quoteExpiresAt: { $lte: new Date() }
    }),
    queryCount("booking has negative amount", "Booking", {
      $or: [{ price: { $lt: 0 } }, { finalAmount: { $lt: 0 } }, { quoteAmount: { $lt: 0 } }]
    }),
    queryCount("partner has invalid service radius", "Partner", {
      $or: [{ serviceRadiusKm: { $lte: 0 } }, { serviceRadiusKm: { $gt: 250 } }]
    }),
    queryCount("location log has invalid coordinates", "LocationLog", {
      $or: [
        { lat: { $lt: -90 } },
        { lat: { $gt: 90 } },
        { lng: { $lt: -180 } },
        { lng: { $gt: 180 } }
      ]
    })
  ]);

  report.slowQueries = await runSlowQueryAudit();

  report.summary = {
    missingIndexes: report.indexes.filter((index) => !index.present || index.uniquePresent === false).length,
    orphanGroups: report.relations.filter((item) => item.count > 0).length,
    duplicateGroups: report.duplicates.filter((item) => item.count > 0).length,
    inconsistentStateGroups: report.stateConsistency.filter((item) => item.count > 0).length,
    slowQueryWarnings: report.slowQueries.filter((item) => !item.ok).length
  };

  if (report.summary.missingIndexes) {
    report.recommendations.push("Run npm run db:migrate -- --apply-indexes to create missing additive indexes.");
  }
  if (report.summary.inconsistentStateGroups) {
    report.recommendations.push("Run npm run db:migrate -- --dry-run, review output, then rerun with --apply for safe state repairs.");
  }
  if (report.summary.orphanGroups || report.summary.duplicateGroups) {
    report.recommendations.push("Review orphan and duplicate samples manually before deleting or merging data.");
  }

  return report;
}

runAudit()
  .then(async (report) => {
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Database audit report written: ${outputPath}`);
    console.log(JSON.stringify(report.summary, null, 2));
    const hasIssues = Object.values(report.summary || {}).some((value) => Number(value) > 0);
    await mongoose.disconnect();
    if (failOnIssues && hasIssues) {
      process.exit(2);
    }
  })
  .catch(async (error) => {
    await mongoose.disconnect().catch(() => {});
    console.error(`Database audit failed: ${error.message}`);
    process.exit(1);
  });
