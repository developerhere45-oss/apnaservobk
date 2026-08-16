const AppControlConfig = require("../models/AppControlConfig");
const AppControlItem = require("../models/AppControlItem");

const DEFAULT_CONFIG = Object.freeze({
  appStatus: { mode: "LIVE", title: "", message: "", bookingEnabled: true },
  launch: { enabled: false, launchAt: "", timezone: "Asia/Kolkata", title: "", dateText: "", description: "", ctaText: "Notify me", imageUrl: "" },
  update: { enabled: false, type: "soft", latestVersion: "", minimumVersion: "", title: "", message: "", buttonText: "Update now", storeUrl: "" },
  features: {},
  services: {}
});

let cached = null;
let cachedAt = 0;

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
function cleanText(value, max = 500) { return String(value || "").trim().slice(0, max); }
function validDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ""; }

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const output = cloneDefaults();
  const modes = new Set(["LIVE", "COMING_SOON", "PARTIALLY_AVAILABLE", "MAINTENANCE", "TEMPORARILY_UNAVAILABLE"]);
  const mode = String(source.appStatus?.mode || output.appStatus.mode).toUpperCase();
  output.appStatus = { mode: modes.has(mode) ? mode : "LIVE", title: cleanText(source.appStatus?.title, 100), message: cleanText(source.appStatus?.message, 500), bookingEnabled: source.appStatus?.bookingEnabled !== false };
  output.launch = { enabled: Boolean(source.launch?.enabled), launchAt: validDate(source.launch?.launchAt), timezone: cleanText(source.launch?.timezone, 60) || "Asia/Kolkata", title: cleanText(source.launch?.title, 100), dateText: cleanText(source.launch?.dateText, 80), description: cleanText(source.launch?.description, 500), ctaText: cleanText(source.launch?.ctaText, 40) || "Notify me", imageUrl: cleanText(source.launch?.imageUrl, 500) };
  const updateType = String(source.update?.type || "soft").toLowerCase();
  output.update = { enabled: Boolean(source.update?.enabled), type: updateType === "force" ? "force" : "soft", latestVersion: cleanText(source.update?.latestVersion, 30), minimumVersion: cleanText(source.update?.minimumVersion, 30), title: cleanText(source.update?.title, 100), message: cleanText(source.update?.message, 500), buttonText: cleanText(source.update?.buttonText, 40) || "Update now", storeUrl: cleanText(source.update?.storeUrl, 500) };
  output.features = Object.fromEntries(Object.entries(source.features && typeof source.features === "object" ? source.features : {}).slice(0, 100).map(([key, item]) => [cleanText(key, 80), { enabled: Boolean(item?.enabled), audience: ["all", "users", "partners", "logged_in"].includes(item?.audience) ? item.audience : "all", startsAt: validDate(item?.startsAt), endsAt: validDate(item?.endsAt), description: cleanText(item?.description, 300) }]));
  output.services = Object.fromEntries(Object.entries(source.services && typeof source.services === "object" ? source.services : {}).slice(0, 300).map(([key, item]) => [cleanText(key, 80), { status: ["AVAILABLE", "PREPARING", "HIGH_DEMAND", "TEMPORARILY_UNAVAILABLE", "COMING_SOON", "DISABLED"].includes(String(item?.status || "").toUpperCase()) ? String(item.status).toUpperCase() : "AVAILABLE", message: cleanText(item?.message, 300), startsAt: validDate(item?.startsAt), endsAt: validDate(item?.endsAt) }]));
  return output;
}

function isScheduleActive(item, now = Date.now()) {
  const start = item.startsAt ? new Date(item.startsAt).getTime() : -Infinity;
  const end = item.endsAt ? new Date(item.endsAt).getTime() : Infinity;
  return start <= now && now <= end;
}

async function getPublishedConfig({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < 10_000) return cached;
  const document = await AppControlConfig.findOne({ key: "customer-app" }).lean();
  cached = { config: normalizeConfig(document?.published), version: Number(document?.version || 0), updatedAt: document?.updatedAt || null };
  cachedAt = Date.now();
  return cached;
}

function invalidatePublishedConfig() { cached = null; cachedAt = 0; }

async function getPublicAppControlConfig(audience = "users") {
  const state = await getPublishedConfig();
  const now = Date.now();
  const [announcements, banners] = await Promise.all(["announcement", "banner"].map(async (kind) => AppControlItem.find({ kind, status: { $in: ["published", "scheduled"] }, audience: { $in: ["all", audience] } }).sort({ priority: 1, createdAt: -1 }).limit(50).lean()));
  const active = (items) => items.filter((item) => isScheduleActive(item, now)).map((item) => ({ id: String(item._id), title: item.title, message: item.message, imageUrl: item.imageUrl, ctaText: item.ctaText, ctaAction: item.ctaAction, serviceCategory: item.serviceCategory, placement: item.placement, priority: item.priority }));
  return { ...state, config: state.config, announcements: active(announcements), banners: active(banners) };
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(".").map((part) => /^\d+$/.test(part) ? Number(part) : 0).slice(0, 4);
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1; }
  return 0;
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, getPublishedConfig, getPublicAppControlConfig, invalidatePublishedConfig, isScheduleActive, compareVersions };
