const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

async function run() {
  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri(), { dbName: "booking-launch-audit" });
  const PlatformSetting = require("../src/models/PlatformSetting");
  const User = require("../src/models/User");
  const AdminNotification = require("../src/models/AdminNotification");
  const { getBookingLaunchConfig, setBookingLaunchAt } = require("../src/utils/bookingLaunchConfig");
  const bookingController = require("../src/controllers/bookingController");

  await PlatformSetting.deleteMany({});
  const beforeLaunch = await getBookingLaunchConfig(new Date("2026-08-15T00:00:00.000Z"));
  assert.equal(beforeLaunch.bookingOpen, false);
  assert.equal(beforeLaunch.launchDateLabel, "20th August");

  const updated = await setBookingLaunchAt("2026-08-25T00:00:00+05:30", "audit@apnaservo.com");
  assert.equal(updated.launchDateLabel, "25th August");
  assert.equal(updated.bookingOpen, false);
  assert.equal(await AdminNotification.countDocuments({ status: "scheduled", targetType: "LAUNCH_SUBSCRIBERS" }), 1);

  let responseStatus = 200;
  let responseBody = null;
  await bookingController.createBooking(
    { body: {}, auth: { uid: "audit-user" } },
    {
      status(code) { responseStatus = code; return this; },
      json(body) { responseBody = body; return this; }
    },
    (error) => { throw error; }
  );
  assert.equal(responseStatus, 423);
  assert.equal(responseBody.code, "BOOKING_PRELAUNCH");

  await bookingController.requestLaunchNotification(
    { body: {}, auth: { uid: "audit-user", name: "Audit User", email: "audit@example.com" } },
    { json(body) { responseBody = body; return this; } },
    (error) => { throw error; }
  );
  assert.equal(responseBody.requested, true);
  const subscriber = await User.findOne({ firebaseUid: "audit-user" });
  assert.ok(subscriber.launchNotificationRequestedAt);
  assert.equal(subscriber.launchNotificationFor.toISOString(), updated.bookingLaunchAt);

  await setBookingLaunchAt("2026-08-10T00:00:00+05:30", "audit@apnaservo.com");
  const afterLaunch = await getBookingLaunchConfig(new Date("2026-08-15T00:00:00.000Z"));
  assert.equal(afterLaunch.bookingOpen, true);

  console.log("Booking launch audit passed: gate, admin config, subscriber, and scheduler verified.");
  await mongoose.disconnect();
  await memory.stop();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
