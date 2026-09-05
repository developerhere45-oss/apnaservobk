const AppControlConfig = require("../models/AppControlConfig");
const AppControlItem = require("../models/AppControlItem");

const DEFAULT_CONFIG = Object.freeze({
  // App status is the only global booking switch; a parallel manual switch
  // would let the dashboard and API disagree.
  appStatus: { mode: "LIVE" },
  launch: { enabled: false, launchAt: "", timezone: "Asia/Kolkata", title: "", dateText: "", description: "", ctaText: "Notify me", imageUrl: "" },
  update: { platforms: { android: { enabled: false, type: "soft", latestVersion: "", latestBuild: 0, minimumVersion: "", minimumBuild: 0, title: "", message: "", buttonText: "Update now", storeUrl: "" }, ios: { enabled: false, type: "soft", latestVersion: "", latestBuild: 0, minimumVersion: "", minimumBuild: 0, title: "", message: "", buttonText: "Update now", storeUrl: "" } } },
  ui: { homeTitle: "", homeSubtitle: "", primaryColor: "#f32368", hiddenSections: [] },
  theme: {
    primaryColor: "#f32368", secondaryColor: "#7e0012", accentColor: "#ff3f5f",
    backgroundColor: "#fff8f4", surfaceColor: "#ffffff", cardColor: "#ffffff",
    textColor: "#161616", secondaryTextColor: "#605b58", borderColor: "#eee1dd",
    successColor: "#16b16f", warningColor: "#d9898d", errorColor: "#d92d55",
    buttonColor: "#ff3f5f", buttonTextColor: "#ffffff", fontFamily: "system",
    borderRadius: 12, buttonRadius: 12, cardRadius: 18
  },
  home: { sections: [] },
  forms: {},
  booking: { enabled: true, maxActiveBookings: 10, minimumNoticeMinutes: 0, cancellationEnabled: true },
  support: { enabled: true, welcomeMessage: "Namaste! How can I help you today?", fallbackReply: "Thank you for explaining the issue. I’ve created a support ticket and shared your message with our team. Please send your booking ID and any relevant details so we can assist you faster.", typingDelayMs: 1400, intents: [] },
  partnerHome: { sections: [] },
  navigation: [],
  laundry: { sections: [], dashboardCards: [], services: [], items: [], pickupWorkflow: [], deliveryWorkflow: [], settings: { pickupEnabled: true, deliveryEnabled: true, staffEnabled: true } },
  features: {},
  services: {},
  // Empty URLs mean use the signed application's bundled artwork. This makes
  // an offline launch safe and lets a failed remote image load fall back cleanly.
  media: { hero: { imageUrl: "", slides: {} }, services: {} }
});

const cache = new Map();
// Realtime sockets deliver publishes immediately. This tiny process-local TTL
// is the safe fallback for missed events without turning every app open into a
// database read under load.
const CONFIG_CACHE_TTL_MS = 2_000;

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
function cleanText(value, max = 500) { return String(value || "").trim().slice(0, max); }
function validDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ""; }
function validMediaUrl(value) {
  const raw = cleanText(value, 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch { return ""; }
}
function color(value, fallback) { const raw = cleanText(value, 7); return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback; }
function boundedNumber(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const output = cloneDefaults();
  const modes = new Set(["LIVE", "PARTIALLY_AVAILABLE", "HIGH_DEMAND", "MAINTENANCE"]);
  const requestedMode = String(source.appStatus?.mode || "").toUpperCase();
  // Missing config is normal for a new install and starts Live. Any persisted
  // unknown value is fail-closed until an admin selects and publishes a valid one.
  output.appStatus = { mode: !requestedMode ? "LIVE" : modes.has(requestedMode) ? requestedMode : "MAINTENANCE" };
  output.launch = { enabled: Boolean(source.launch?.enabled), launchAt: validDate(source.launch?.launchAt), timezone: cleanText(source.launch?.timezone, 60) || "Asia/Kolkata", title: cleanText(source.launch?.title, 100), dateText: cleanText(source.launch?.dateText, 80), description: cleanText(source.launch?.description, 500), ctaText: cleanText(source.launch?.ctaText, 40) || "Notify me", imageUrl: cleanText(source.launch?.imageUrl, 500) };
  const normalizeUpdate = (value = {}) => {
    const type = ["force", "mandatory"].includes(String(value.type || "soft").toLowerCase()) ? "force" : "soft";
    return { enabled: Boolean(value.enabled), type, latestVersion: cleanText(value.latestVersion, 30), latestBuild: boundedNumber(value.latestBuild, 0, 0, 2147483647), minimumVersion: cleanText(value.minimumVersion, 30), minimumBuild: boundedNumber(value.minimumBuild, 0, 0, 2147483647), title: cleanText(value.title, 100), message: cleanText(value.message, 2000), buttonText: cleanText(value.buttonText, 40) || "Update now", storeUrl: cleanText(value.storeUrl, 500) };
  };
  const legacyUpdate = source.update || {};
  output.update = { platforms: { android: normalizeUpdate(source.update?.platforms?.android || legacyUpdate), ios: normalizeUpdate(source.update?.platforms?.ios || {}) } };
  const primaryColor = cleanText(source.ui?.primaryColor, 7);
  const allowedSections = new Set(["hero", "announcements", "quick_services", "commercial", "popular_services", "more_services", "feature_strip", "online", "stats", "recent_requests"]);
  output.ui = { homeTitle: cleanText(source.ui?.homeTitle, 80), homeSubtitle: cleanText(source.ui?.homeSubtitle, 160), primaryColor: /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#f32368", hiddenSections: [...new Set(Array.isArray(source.ui?.hiddenSections) ? source.ui.hiddenSections.map((item) => cleanText(item, 40)).filter((item) => allowedSections.has(item)) : [])].slice(0, 12) };
  const defaults = output.theme;
  output.theme = {
    primaryColor: color(source.theme?.primaryColor || source.ui?.primaryColor, defaults.primaryColor),
    secondaryColor: color(source.theme?.secondaryColor, defaults.secondaryColor), accentColor: color(source.theme?.accentColor, defaults.accentColor),
    backgroundColor: color(source.theme?.backgroundColor, defaults.backgroundColor), surfaceColor: color(source.theme?.surfaceColor, defaults.surfaceColor),
    cardColor: color(source.theme?.cardColor, defaults.cardColor), textColor: color(source.theme?.textColor, defaults.textColor),
    secondaryTextColor: color(source.theme?.secondaryTextColor, defaults.secondaryTextColor), borderColor: color(source.theme?.borderColor, defaults.borderColor),
    successColor: color(source.theme?.successColor, defaults.successColor), warningColor: color(source.theme?.warningColor, defaults.warningColor),
    errorColor: color(source.theme?.errorColor, defaults.errorColor), buttonColor: color(source.theme?.buttonColor, defaults.buttonColor),
    buttonTextColor: color(source.theme?.buttonTextColor, defaults.buttonTextColor),
    fontFamily: ["system", "sans", "serif", "monospace"].includes(cleanText(source.theme?.fontFamily, 20)) ? cleanText(source.theme?.fontFamily, 20) : "system",
    borderRadius: boundedNumber(source.theme?.borderRadius, 12, 0, 32), buttonRadius: boundedNumber(source.theme?.buttonRadius, 12, 0, 32), cardRadius: boundedNumber(source.theme?.cardRadius, 18, 0, 40)
  };
  const sectionIds = new Set(["hero", "announcements", "quick_services", "commercial", "popular_services", "more_services", "feature_strip", "support"]);
  output.home = { sections: (Array.isArray(source.home?.sections) ? source.home.sections : []).slice(0, 30).map((item, index) => ({
    id: cleanText(item?.id, 40), enabled: item?.enabled !== false, position: boundedNumber(item?.position, index, 0, 100),
    title: cleanText(item?.title, 100), subtitle: cleanText(item?.subtitle, 200), imageUrl: validMediaUrl(item?.imageUrl),
    ctaText: cleanText(item?.ctaText, 40), ctaAction: cleanText(item?.ctaAction, 120)
  })).filter((item) => sectionIds.has(item.id)).sort((a, b) => a.position - b.position) };
  const allowedFieldTypes = new Set(["text", "textarea", "number", "phone", "email", "date", "time", "dateTime", "singleSelect", "multiSelect", "radio", "checkbox", "imageUpload", "location", "address"]);
  output.forms = Object.fromEntries(Object.entries(source.forms && typeof source.forms === "object" ? source.forms : {}).slice(0, 100).map(([serviceId, schema]) => [cleanText(serviceId, 80), {
    version: boundedNumber(schema?.version, 1, 1, 100000), fields: (Array.isArray(schema?.fields) ? schema.fields : []).slice(0, 60).map((field, index) => ({
      id: cleanText(field?.id, 80), label: cleanText(field?.label, 120), type: allowedFieldTypes.has(field?.type) ? field.type : "text",
      placeholder: cleanText(field?.placeholder, 200), required: Boolean(field?.required), defaultValue: cleanText(field?.defaultValue, 500),
      options: (Array.isArray(field?.options) ? field.options : []).slice(0, 100).map((option) => cleanText(option, 120)).filter(Boolean),
      visible: field?.visible !== false, order: boundedNumber(field?.order, index, 0, 1000), helpText: cleanText(field?.helpText, 300),
      validation: { minLength: boundedNumber(field?.validation?.minLength, 0, 0, 10000), maxLength: boundedNumber(field?.validation?.maxLength, 1000, 1, 10000), minValue: boundedNumber(field?.validation?.minValue, 0, -100000000, 100000000), maxValue: boundedNumber(field?.validation?.maxValue, 100000000, -100000000, 100000000), regex: cleanText(field?.validation?.regex, 300) }
    })).filter((field) => field.id && field.label && field.visible).sort((a, b) => a.order - b.order)
  }]));
  output.booking = { enabled: source.booking?.enabled !== false, maxActiveBookings: boundedNumber(source.booking?.maxActiveBookings, 10, 1, 100), minimumNoticeMinutes: boundedNumber(source.booking?.minimumNoticeMinutes, 0, 0, 10080), cancellationEnabled: source.booking?.cancellationEnabled !== false };
  output.support = {
    enabled: source.support?.enabled !== false,
    welcomeMessage: cleanText(source.support?.welcomeMessage, 500) || DEFAULT_CONFIG.support.welcomeMessage,
    fallbackReply: cleanText(source.support?.fallbackReply, 1000) || DEFAULT_CONFIG.support.fallbackReply,
    typingDelayMs: boundedNumber(source.support?.typingDelayMs, 1400, 600, 5000),
    intents: (Array.isArray(source.support?.intents) ? source.support.intents : []).slice(0, 50).map((intent, index) => ({
      id: cleanText(intent?.id, 60) || `intent_${index + 1}`,
      keywords: (Array.isArray(intent?.keywords) ? intent.keywords : []).slice(0, 40).map((keyword) => cleanText(keyword, 80)).filter(Boolean),
      reply: cleanText(intent?.reply, 1000)
    })).filter((intent) => intent.keywords.length && intent.reply)
  };
  const partnerSectionTypes = new Set(["online", "stats", "recent_requests", "quick_actions", "active_jobs", "earnings", "banner", "imageBanner", "text", "card", "announcement", "promotion", "emptyState", "staffList", "orderList"]);
  const normalizePartnerSections = (items) => (Array.isArray(items) ? items : []).slice(0, 40).map((item, index) => ({
    id: cleanText(item?.id, 60), type: partnerSectionTypes.has(item?.type) ? item.type : "card", enabled: item?.enabled !== false,
    position: boundedNumber(item?.position, index, 0, 1000), title: cleanText(item?.title, 120), subtitle: cleanText(item?.subtitle, 300),
    body: cleanText(item?.body, 1000), imageUrl: validMediaUrl(item?.imageUrl), icon: cleanText(item?.icon, 40),
    ctaText: cleanText(item?.ctaText, 50), ctaAction: cleanText(item?.ctaAction, 100)
  })).filter((item) => item.id).sort((a, b) => a.position - b.position);
  output.partnerHome = { sections: normalizePartnerSections(source.partnerHome?.sections) };
  const safeDestinations = new Set(["home", "bookings", "orders", "earnings", "profile", "laundry", "staff", "notifications"]);
  output.navigation = (Array.isArray(source.navigation) ? source.navigation : []).slice(0, 12).map((item, index) => ({
    id: cleanText(item?.id, 40), label: cleanText(item?.label, 40), icon: cleanText(item?.icon, 40), destination: cleanText(item?.destination, 40),
    enabled: item?.enabled !== false, position: boundedNumber(item?.position, index, 0, 100)
  })).filter((item) => item.id && safeDestinations.has(item.destination)).sort((a, b) => a.position - b.position);
  const metricIds = new Set(["new_orders", "pickup_scheduled", "in_washing", "ready_for_delivery", "out_for_delivery", "today_earnings", "active_staff"]);
  const workflowStatuses = new Set(["accepted", "pickup_scheduled", "on_the_way", "arrived", "picked_up", "in_washing", "ready_for_delivery", "delivery_assigned", "out_for_delivery", "delivered"]);
  const catalogItems = (items) => (Array.isArray(items) ? items : []).slice(0, 100).map((item, index) => ({ id: cleanText(item?.id, 60), name: cleanText(item?.name, 100), description: cleanText(item?.description, 300), imageUrl: validMediaUrl(item?.imageUrl), icon: cleanText(item?.icon, 40), enabled: item?.enabled !== false, order: boundedNumber(item?.order, index, 0, 1000) })).filter((item) => item.id && item.name).sort((a, b) => a.order - b.order);
  const workflow = (steps) => (Array.isArray(steps) ? steps : []).slice(0, 20).map((step, index) => ({ id: cleanText(step?.id, 60), status: cleanText(step?.status, 60), label: cleanText(step?.label, 100), description: cleanText(step?.description, 300), enabled: step?.enabled !== false, order: boundedNumber(step?.order, index, 0, 100), color: color(step?.color, "#f32368"), staffRequired: Boolean(step?.staffRequired) })).filter((step) => step.id && workflowStatuses.has(step.status)).sort((a, b) => a.order - b.order);
  output.laundry = {
    sections: normalizePartnerSections(source.laundry?.sections),
    dashboardCards: (Array.isArray(source.laundry?.dashboardCards) ? source.laundry.dashboardCards : []).slice(0, 20).map((card, index) => ({ id: cleanText(card?.id, 60), metric: cleanText(card?.metric, 60), title: cleanText(card?.title, 80), subtitle: cleanText(card?.subtitle, 120), icon: cleanText(card?.icon, 40), color: color(card?.color, "#f32368"), enabled: card?.enabled !== false, order: boundedNumber(card?.order, index, 0, 100) })).filter((card) => card.id && metricIds.has(card.metric)).sort((a, b) => a.order - b.order),
    services: catalogItems(source.laundry?.services), items: catalogItems(source.laundry?.items),
    pickupWorkflow: workflow(source.laundry?.pickupWorkflow), deliveryWorkflow: workflow(source.laundry?.deliveryWorkflow),
    settings: { pickupEnabled: source.laundry?.settings?.pickupEnabled !== false, deliveryEnabled: source.laundry?.settings?.deliveryEnabled !== false, staffEnabled: source.laundry?.settings?.staffEnabled !== false }
  };
  output.features = Object.fromEntries(Object.entries(source.features && typeof source.features === "object" ? source.features : {}).slice(0, 100).map(([key, item]) => [cleanText(key, 80), { enabled: Boolean(item?.enabled), audience: ["all", "users", "partners", "logged_in"].includes(item?.audience) ? item.audience : "all", startsAt: validDate(item?.startsAt), endsAt: validDate(item?.endsAt), description: cleanText(item?.description, 300) }]));
  output.services = Object.fromEntries(Object.entries(source.services && typeof source.services === "object" ? source.services : {}).slice(0, 300).map(([key, item]) => [cleanText(key, 80), { status: ["AVAILABLE", "PREPARING", "HIGH_DEMAND", "TEMPORARILY_UNAVAILABLE", "DISABLED"].includes(String(item?.status || "").toUpperCase()) ? String(item.status).toUpperCase() : "AVAILABLE", message: cleanText(item?.message, 300), startsAt: validDate(item?.startsAt), endsAt: validDate(item?.endsAt) }]));
  const mediaServices = source.media?.services && typeof source.media.services === "object" ? source.media.services : {};
  const heroSlides = source.media?.hero?.slides && typeof source.media.hero.slides === "object" ? source.media.hero.slides : {};
  output.media = {
    hero: { imageUrl: validMediaUrl(source.media?.hero?.imageUrl), slides: Object.fromEntries(Object.entries(heroSlides).slice(0, 100).map(([key, item]) => [cleanText(key, 80), { imageUrl: validMediaUrl(item?.imageUrl) }]).filter(([key]) => key)) },
    services: Object.fromEntries(Object.entries(mediaServices).slice(0, 100).map(([key, item]) => [cleanText(key, 80), { imageUrl: validMediaUrl(item?.imageUrl) }]).filter(([key]) => key)),
  };
  return output;
}

function isScheduleActive(item, now = Date.now()) {
  const start = item.startsAt ? new Date(item.startsAt).getTime() : -Infinity;
  const end = item.endsAt ? new Date(item.endsAt).getTime() : Infinity;
  return start <= now && now <= end;
}

function normalizedApp(app) { return String(app || "customer").toLowerCase() === "partner" ? "partner" : "customer"; }
function normalizedPlatform(platform) { return String(platform || "android").toLowerCase() === "ios" ? "ios" : "android"; }

async function getPublishedConfig({ force = false, app = "customer", platform = "android" } = {}) {
  const target = normalizedApp(app);
  const targetPlatform = normalizedPlatform(platform);
  const cacheKey = `${target}:${targetPlatform}`;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CONFIG_CACHE_TTL_MS) return cached.value;
  const key = target === "customer" && targetPlatform === "ios" ? "customer-ios-app" : `${target}-app`;
  const document = await AppControlConfig.findOne({ key }).lean();
  const value = { config: normalizeConfig(document?.published), version: Number(document?.version || 0), publishedAt: document?.publishedAt || null, updatedAt: document?.updatedAt || null };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function bookingAvailability(config) {
  if (config?.booking?.enabled === false) {
    return { allowed: false, httpStatus: 503, code: "NEW_BOOKINGS_DISABLED", message: "New bookings are temporarily paused. Existing bookings remain available." };
  }
  const mode = config?.appStatus?.mode || "LIVE";
  if (mode === "MAINTENANCE") {
    return { allowed: false, httpStatus: 503, code: "APP_MAINTENANCE", message: "ApnaServo is under maintenance. Please try again after some time." };
  }
  if (mode === "HIGH_DEMAND") {
    return { allowed: false, httpStatus: 503, code: "APP_HIGH_DEMAND", message: "We are currently receiving a high number of service requests. Please try again after some time." };
  }
  return { allowed: true };
}

function invalidatePublishedConfig(app, platform) { if (app) cache.delete(`${normalizedApp(app)}:${normalizedPlatform(platform)}`); else cache.clear(); }

async function getPublicAppControlConfig(audience = "users", app = "customer", platform = "android") {
  const target = normalizedApp(app);
  const targetPlatform = normalizedPlatform(platform);
  const state = await getPublishedConfig({ app: target, platform: targetPlatform });
  const now = Date.now();
  const appFilter = target === "customer"
    ? { $and: [{ $or: [{ app: "customer" }, { app: { $exists: false } }] }, targetPlatform === "ios" ? { platform: "ios" } : { $or: [{ platform: "android" }, { platform: { $exists: false } }] }] }
    : { app: "partner" };
  const announcements = await AppControlItem.find({ ...appFilter, kind: "announcement", status: "published", audience: { $in: ["all", audience] } }).sort({ priority: 1, createdAt: -1 }).limit(50).lean();
  const banners = target === "partner" ? [] : await AppControlItem.find({ ...appFilter, kind: "banner", status: "published", audience: { $in: ["all", audience] } }).sort({ priority: 1, createdAt: -1 }).limit(50).lean();
  const active = (items) => items.filter((item) => isScheduleActive(item, now)).map((item) => ({ id: String(item._id), title: item.title, message: item.message, imageUrl: item.imageUrl, ctaText: item.ctaText, ctaAction: item.ctaAction, serviceCategory: item.serviceCategory, placement: item.placement, priority: item.priority, bannerStyle: item.bannerStyle || {} }));
  return { ...state, app: target, configVersion: state.version, config: state.config, announcements: active(announcements), banners: active(banners) };
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(".").map((part) => /^\d+$/.test(part) ? Number(part) : 0).slice(0, 4);
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1; }
  return 0;
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, getPublishedConfig, getPublicAppControlConfig, invalidatePublishedConfig, isScheduleActive, bookingAvailability, compareVersions, normalizedApp, normalizedPlatform };
