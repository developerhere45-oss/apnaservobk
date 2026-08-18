const PlatformSetting = require("../models/PlatformSetting");
const AdminNotification = require("../models/AdminNotification");
const User = require("../models/User");

const SETTING_KEY = "bookingLaunchAt";
const DEFAULT_BOOKING_LAUNCH_AT = "2026-08-20T00:00:00+05:30";

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function configuredFallback() {
  return validDate(process.env.BOOKING_LAUNCH_AT) || new Date(DEFAULT_BOOKING_LAUNCH_AT);
}

function launchDateLabel(date) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Kolkata"
  }).formatToParts(date);
  const day = Number(parts.find((part) => part.type === "day")?.value || 0);
  const month = parts.find((part) => part.type === "month")?.value || "August";
  const suffix = day % 10 === 1 && day % 100 !== 11
    ? "st"
    : day % 10 === 2 && day % 100 !== 12
      ? "nd"
      : day % 10 === 3 && day % 100 !== 13
        ? "rd"
        : "th";
  return `${day}${suffix} ${month}`;
}

async function getBookingLaunchConfig(now = new Date()) {
  const setting = await PlatformSetting.findOne({ key: SETTING_KEY }).lean();
  const launchAt = validDate(setting?.value) || configuredFallback();
  return {
    bookingLaunchAt: launchAt.toISOString(),
    bookingOpen: now.getTime() >= launchAt.getTime(),
    serverNow: now.toISOString(),
    launchDateLabel: launchDateLabel(launchAt),
    source: setting ? "admin" : process.env.BOOKING_LAUNCH_AT ? "environment" : "default",
    updatedAt: setting?.updatedAt ? new Date(setting.updatedAt).toISOString() : "",
    updatedBy: setting?.updatedBy || ""
  };
}

async function setBookingLaunchAt(value, updatedBy) {
  const launchAt = validDate(value);
  if (!launchAt) {
    const error = new Error("bookingLaunchAt must be a valid ISO date-time");
    error.status = 400;
    throw error;
  }
  await PlatformSetting.findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { value: launchAt.toISOString(), updatedBy: updatedBy || "admin" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const config = await getBookingLaunchConfig();
  await User.updateMany(
    { launchNotificationRequestedAt: { $ne: null } },
    { $set: { launchNotificationFor: launchAt } }
  );
  await ensureLaunchNotificationSchedule(config);
  return config;
}

async function ensureLaunchNotificationSchedule(config) {
  const launchAt = new Date(config.bookingLaunchAt);
  const idempotencyKey = `booking-launch:${launchAt.toISOString()}`;
  await AdminNotification.updateMany(
    {
      status: "scheduled",
      "metadata.kind": "booking_launch",
      idempotencyKey: { $ne: idempotencyKey }
    },
    { $set: { status: "cancelled" } }
  );
  if (launchAt.getTime() <= Date.now()) return null;
  return AdminNotification.findOneAndUpdate(
    { idempotencyKey },
    {
      $setOnInsert: {
        title: "ApnaServo is Live!",
        message: "Service booking is now open. Book your service with ApnaServo.",
        targetType: "LAUNCH_SUBSCRIBERS",
        actionType: "OPEN_HOME",
        actionId: "",
        status: "scheduled",
        scheduleAt: launchAt,
        sentBy: "booking-launch-system",
        sentByEmail: "",
        metadata: { kind: "booking_launch" }
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = {
  DEFAULT_BOOKING_LAUNCH_AT,
  getBookingLaunchConfig,
  setBookingLaunchAt,
  ensureLaunchNotificationSchedule
};
