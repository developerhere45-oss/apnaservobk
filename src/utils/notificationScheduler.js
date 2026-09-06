const AdminNotification = require("../models/AdminNotification");
const { deliverAdminNotification } = require("./adminNotificationDelivery");

let scheduler;
let ticking = false;

const MAX_PER_TICK = 25;
const STUCK_AFTER_MS = 10 * 60 * 1000;

function startNotificationScheduler() {
  if (scheduler || process.env.DISABLE_NOTIFICATION_SCHEDULER === "true") return;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      // A deploy/restart can interrupt delivery after the job was claimed.
      // Recover those abandoned jobs so a future scheduler pass retries them.
      await AdminNotification.updateMany(
        { status: "sending", sentAt: null, updatedAt: { $lte: new Date(now.getTime() - STUCK_AFTER_MS) } },
        { $set: { status: "scheduled" }, $push: { errorMessages: { code: "scheduler_recovered", message: "Recovered interrupted scheduled delivery" } } }
      );

      for (let index = 0; index < MAX_PER_TICK; index += 1) {
        const due = await AdminNotification.findOne(
          { status: "scheduled", scheduleAt: { $lte: new Date() } },
        ).sort({ scheduleAt: 1 });
        if (!due) break;
        try {
          await deliverAdminNotification(due);
        } catch (error) {
          await AdminNotification.updateOne(
            { _id: due._id, status: "sending" },
            { $set: { status: "failed" }, $push: { errorMessages: { code: "scheduler_error", message: String(error.message || error).slice(0, 240) } } }
          );
        }
      }
    } finally {
      ticking = false;
    }
  }

  // Process overdue jobs immediately whenever Render wakes or redeploys.
  tick().catch((error) => console.error("Initial notification scheduler run failed:", error.message));
  scheduler = setInterval(() => {
    tick().catch((error) => console.error("Notification scheduler failed:", error.message));
  }, Math.max(5000, Number(process.env.NOTIFICATION_SCHEDULER_INTERVAL_MS || 15000)));
  scheduler.unref?.();
}

module.exports = {
  startNotificationScheduler
};
