const fs = require("fs");
const path = require("path");
const vm = require("vm");

const delivered = [];
const jobs = [
  { _id: "due-1", status: "scheduled", scheduleAt: new Date(Date.now() - 2000) },
  { _id: "due-2", status: "scheduled", scheduleAt: new Date(Date.now() - 1000) }
];
let recoveryRan = false;
let intervalMs = 0;

const AdminNotification = {
  async updateMany() { recoveryRan = true; },
  findOne() {
    return {
      async sort() { return jobs.find((job) => job.status === "scheduled") || null; }
    };
  },
  async updateOne(filter) {
    const job = jobs.find((item) => item._id === filter._id);
    if (job) job.status = "failed";
  }
};

async function deliverAdminNotification(job) {
  job.status = "sent";
  delivered.push(job._id);
}

const filename = path.join(__dirname, "../src/utils/notificationScheduler.js");
const source = fs.readFileSync(filename, "utf8");
const moduleRef = { exports: {} };
const sandbox = {
  module: moduleRef,
  exports: moduleRef.exports,
  process: { env: {} },
  console,
  Date,
  setInterval(callback, ms) {
    intervalMs = ms;
    return { unref() {} };
  },
  require(request) {
    if (request === "../models/AdminNotification") return AdminNotification;
    if (request === "./adminNotificationDelivery") return { deliverAdminNotification };
    throw new Error(`Unexpected dependency: ${request}`);
  }
};

vm.runInNewContext(source, sandbox, { filename });
moduleRef.exports.startNotificationScheduler();

setTimeout(() => {
  if (!recoveryRan) throw new Error("Scheduler did not run interrupted-job recovery");
  if (delivered.join(",") !== "due-1,due-2") throw new Error(`Expected both overdue jobs, got: ${delivered.join(",")}`);
  if (intervalMs !== 15000) throw new Error(`Expected 15-second interval, got: ${intervalMs}`);
  console.log("notification_scheduler_audit_passed", { delivered: delivered.length, intervalMs });
}, 100);
