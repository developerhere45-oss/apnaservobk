const fs = require("node:fs");
const path = require("node:path");

const config = {
  users: intArg("--users", 10000),
  partners: intArg("--partners", 2000),
  bookings: intArg("--bookings", 5000),
  quotes: intArg("--quotes", 3000),
  chatMessages: intArg("--chat-messages", 50000),
  matchedPartnersPerBooking: intArg("--matched-partners", 12),
  bookingConcurrency: intArg("--booking-concurrency", 120),
  quoteConcurrency: intArg("--quote-concurrency", 180),
  chatConcurrency: intArg("--chat-concurrency", 300),
  notificationConcurrency: intArg("--notification-concurrency", Number(process.env.NOTIFICATION_CONCURRENCY || 8)),
  dbReadMs: intArg("--db-read-ms", 8),
  dbWriteMs: intArg("--db-write-ms", 14),
  fcmMs: intArg("--fcm-ms", 90),
  socketEmitMs: intArg("--socket-ms", 2),
  output: stringArg("--out", path.resolve(__dirname, "../scale-simulation-report.json"))
};

function intArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function stringArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function ms(value) {
  return Math.round(value);
}

function seconds(value) {
  return Number((value / 1000).toFixed(2));
}

function estimateQueue({ name, jobs, concurrency, workMs, writes = 0, reads = 0, notifications = 0, socketEvents = 0 }) {
  const safeConcurrency = Math.max(1, concurrency);
  const waves = Math.ceil(jobs / safeConcurrency);
  const totalMs = waves * workMs;
  const throughputPerSecond = totalMs > 0 ? Math.round((jobs / totalMs) * 1000) : 0;
  return {
    name,
    jobs,
    concurrency: safeConcurrency,
    perJobMs: ms(workMs),
    estimatedTotalSeconds: seconds(totalMs),
    estimatedThroughputPerSecond: throughputPerSecond,
    writes,
    reads,
    notifications,
    socketEvents
  };
}

function pressureLabel(stage) {
  if (stage.estimatedTotalSeconds <= 30) return "ok";
  if (stage.estimatedTotalSeconds <= 120) return "watch";
  return "bottleneck";
}

function recommendations(stages) {
  const notes = [];
  const notificationStage = stages.find((stage) => stage.name === "notification spike");
  const bookingStage = stages.find((stage) => stage.name === "mass bookings");
  const chatStage = stages.find((stage) => stage.name === "chat spike");

  if (notificationStage && notificationStage.estimatedTotalSeconds > 120) {
    notes.push("Move push/SMS fanout to a durable queue worker. API should write InAppNotification and return immediately; workers send FCM/SMS with retries.");
  }
  if (config.notificationConcurrency < 16 && notificationStage?.notifications > 50000) {
    notes.push("Raise NOTIFICATION_CONCURRENCY gradually from 8 to 16/24 only after checking MongoDB write latency and FCM error rate.");
  }
  if (bookingStage && bookingStage.estimatedTotalSeconds > 60) {
    notes.push("Keep nearby partner query capped at 30 and use 2dsphere indexes. Add Redis cache for online partner ids per service/city.");
  }
  if (chatStage && chatStage.estimatedTotalSeconds > 120) {
    notes.push("Split chat write path from notification fanout. Store messages first, enqueue notification, and use Socket.IO Redis adapter for multi-instance delivery.");
  }

  notes.push("Use MongoDB Atlas M10/M20 minimum for launch testing; add read/write alerts for p95 latency > 100 ms.");
  notes.push("Run at least 2 backend instances behind Render/Railway load balancer; use sticky sessions or Socket.IO Redis adapter for realtime.");
  notes.push("Add Redis-backed queues for notifications, quote expiry sweeps, SMS retries, and fraud scans before public launch.");
  notes.push("Keep rate limits separate by endpoint: login, booking create, chat send, quote update, document upload.");
  return [...new Set(notes)];
}

function runSimulation() {
  const registrationWrites = config.users + config.partners;
  const bookingWritesPerJob = 3;
  const bookingReadsPerJob = 2;
  const bookingNotifications = config.bookings * config.matchedPartnersPerBooking;
  const quoteWritesPerJob = 2;
  const quoteReadsPerJob = 2;
  const quoteNotifications = config.quotes;
  const chatWritesPerJob = 1;
  const chatReadsPerJob = 1;
  const chatNotifications = config.chatMessages;

  const stages = [
    estimateQueue({
      name: "mass registrations",
      jobs: registrationWrites,
      concurrency: 250,
      workMs: config.dbWriteMs,
      writes: registrationWrites
    }),
    estimateQueue({
      name: "mass bookings",
      jobs: config.bookings,
      concurrency: config.bookingConcurrency,
      workMs: bookingWritesPerJob * config.dbWriteMs + bookingReadsPerJob * config.dbReadMs + config.socketEmitMs,
      writes: config.bookings * bookingWritesPerJob,
      reads: config.bookings * bookingReadsPerJob,
      notifications: bookingNotifications,
      socketEvents: bookingNotifications
    }),
    estimateQueue({
      name: "simultaneous quote submissions",
      jobs: config.quotes,
      concurrency: config.quoteConcurrency,
      workMs: quoteWritesPerJob * config.dbWriteMs + quoteReadsPerJob * config.dbReadMs + config.socketEmitMs,
      writes: config.quotes * quoteWritesPerJob,
      reads: config.quotes * quoteReadsPerJob,
      notifications: quoteNotifications,
      socketEvents: quoteNotifications
    }),
    estimateQueue({
      name: "notification spike",
      jobs: bookingNotifications + quoteNotifications + chatNotifications,
      concurrency: config.notificationConcurrency,
      workMs: config.dbWriteMs * 2 + config.fcmMs,
      writes: (bookingNotifications + quoteNotifications + chatNotifications) * 2,
      notifications: bookingNotifications + quoteNotifications + chatNotifications
    }),
    estimateQueue({
      name: "chat spike",
      jobs: config.chatMessages,
      concurrency: config.chatConcurrency,
      workMs: chatWritesPerJob * config.dbWriteMs + chatReadsPerJob * config.dbReadMs + config.socketEmitMs,
      writes: config.chatMessages * chatWritesPerJob,
      reads: config.chatMessages * chatReadsPerJob,
      notifications: chatNotifications,
      socketEvents: config.chatMessages * 2
    })
  ].map((stage) => ({
    ...stage,
    pressure: pressureLabel(stage)
  }));

  const notificationDemand = bookingNotifications + quoteNotifications + chatNotifications;
  const totals = {
    writes: stages.reduce((sum, stage) => sum + stage.writes, 0),
    reads: stages.reduce((sum, stage) => sum + stage.reads, 0),
    notifications: notificationDemand,
    socketEvents: stages.reduce((sum, stage) => sum + stage.socketEvents, 0)
  };

  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: config,
    totals,
    stages,
    bottlenecks: stages.filter((stage) => stage.pressure !== "ok"),
    recommendations: recommendations(stages)
  };

  fs.writeFileSync(config.output, `${JSON.stringify(report, null, 2)}\n`);
  console.table(stages.map((stage) => ({
    stage: stage.name,
    jobs: stage.jobs,
    concurrency: stage.concurrency,
    seconds: stage.estimatedTotalSeconds,
    throughputPerSec: stage.estimatedThroughputPerSecond,
    pressure: stage.pressure
  })));
  console.log(`\nScale simulation report written: ${config.output}`);
  console.log("Totals:", totals);
  console.log("Recommendations:");
  report.recommendations.forEach((note) => console.log(`- ${note}`));
}

runSimulation();
