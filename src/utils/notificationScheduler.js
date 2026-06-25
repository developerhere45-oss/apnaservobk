const AdminNotification = require("../models/AdminNotification");
const { deliverAdminNotification } = require("./adminNotificationDelivery");

let scheduler;

function startNotificationScheduler() {
  if (scheduler || process.env.DISABLE_NOTIFICATION_SCHEDULER === "true") return;

  async function tick() {
    const now = new Date();
    const due = await AdminNotification.findOne(
      { status: "scheduled", scheduleAt: { $lte: now } },
    ).sort({ scheduleAt: 1 });
    if (!due) return;
    try {
      await deliverAdminNotification(due);
    } catch (error) {
      due.status = "failed";
      due.errorMessages = [{ code: "scheduler_error", message: error.message }];
      await due.save();
    }
  }

  scheduler = setInterval(() => {
    tick().catch((error) => console.error("Notification scheduler failed:", error.message));
  }, Number(process.env.NOTIFICATION_SCHEDULER_INTERVAL_MS || 30000));
  scheduler.unref?.();
}

module.exports = {
  startNotificationScheduler
};
