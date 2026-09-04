const AppControlConfig = require("../models/AppControlConfig");
const AppControlItem = require("../models/AppControlItem");
const AdminActivity = require("../models/AdminActivity");
const Service = require("../models/Service");
const Partner = require("../models/Partner");
const FeatureRegistry = require("../models/FeatureRegistry");
const AppControlMediaAsset = require("../models/AppControlMediaAsset");
const mongoose = require("mongoose");
const { cloudinary } = require("../config/cloudinary");
const { Readable } = require("stream");
const { emitAdminEvent } = require("../sockets/bookingSocket");
const {
  normalizeConfig,
  getPublicAppControlConfig,
  invalidatePublishedConfig,
  normalizedApp,
  normalizedPlatform,
} = require("../utils/appControl");
const {
  normalizeServiceCategory,
  serviceCatalog,
  serviceCategoryVariants,
} = require("../utils/serviceCategory");

function targetApp(req) {
  return normalizedApp(req.query?.app || req.body?.app);
}
function targetPlatform(req) {
  return normalizedPlatform(req.query?.platform || req.body?.platform);
}
function configKey(req) {
  const app = targetApp(req);
  return app === "customer" && targetPlatform(req) === "ios"
    ? "customer-ios-app"
    : `${app}-app`;
}
function actor(req) {
  return String(
    req.auth?.email || req.headers["x-admin-actor"] || "admin",
  ).slice(0, 160);
}
function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function contentFilter(app, platform = "android") {
  return app === "customer"
    ? {
        $and: [
          { $or: [{ app: "customer" }, { app: { $exists: false } }] },
          platform === "ios"
            ? { platform: "ios" }
            : {
                $or: [
                  { platform: "android" },
                  { platform: { $exists: false } },
                ],
              },
        ],
      }
    : { app: "partner" };
}
function assertSuperAdmin(req) {
  if (
    req.authType === "admin_jwt" &&
    req.adminProfile?.role !== "super_admin"
  ) {
    const error = new Error(
      "Only a Super Admin can change App Control Center settings",
    );
    error.status = 403;
    throw error;
  }
}
function merge(base, patch) {
  const output = { ...(isObject(base) ? base : {}) };
  for (const [name, value] of Object.entries(isObject(patch) ? patch : {}))
    output[name] = isObject(value) ? merge(output[name], value) : value;
  return output;
}
function publicBaseUrl(req) {
  const configured = String(
    process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_BASE_URL || "",
  ).replace(/\/$/, "");
  if (configured) return configured;
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https")
    .split(",")[0]
    .trim();
  return host
    ? `${host.includes("onrender.com") ? "https" : proto}://${host}`
    : "";
}
function uploadMediaToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "apnaservo/app-control",
        resource_type: "image",
        overwrite: false,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
    Readable.from(file.buffer).pipe(stream);
  });
}
function normalizedReleaseVersion(value) {
  const version = String(value || "")
    .trim()
    .replace(/^v/i, "");
  if (!version) return "";
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
    const error = new Error("Target app version must look like 1.0.16");
    error.status = 400;
    throw error;
  }
  return version;
}
function compareReleaseVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}
function managedPlatformUpdate(value) {
  const type = ["force", "mandatory"].includes(
    String(value?.type || "soft").toLowerCase(),
  )
    ? "force"
    : "soft";
  const target = normalizedReleaseVersion(value?.latestVersion);
  const enabled = Boolean(value?.enabled) && Boolean(target);
  const minimum =
    enabled && value?.minimumVersion
      ? normalizedReleaseVersion(value.minimumVersion)
      : "";
  if (minimum && compareReleaseVersions(minimum, target) > 0) {
    const error = new Error(
      "Minimum version cannot be newer than the target version",
    );
    error.status = 400;
    throw error;
  }
  return {
    enabled,
    type,
    latestVersion: target,
    latestBuild: Math.max(0, Math.trunc(Number(value?.latestBuild || 0))),
    minimumVersion: minimum,
    minimumBuild: Math.max(0, Math.trunc(Number(value?.minimumBuild || 0))),
    title: String(value?.title || "").trim(),
    message: String(value?.message || "").trim(),
    buttonText:
      String(value?.buttonText || "Update Now").trim() || "Update Now",
    storeUrl: String(value?.storeUrl || "").trim(),
  };
}
function managedUpdate(value) {
  const platforms = value?.platforms || { android: value };
  return {
    platforms: {
      android: managedPlatformUpdate(platforms.android || {}),
      ios: managedPlatformUpdate(platforms.ios || {}),
    },
  };
}
const managedCustomerUpdate = managedUpdate;
function bannerStyle(value) {
  const source = isObject(value) ? value : {};
  const safeColor = (key, fallback) =>
    /^#[0-9a-fA-F]{6}$/.test(String(source[key] || ""))
      ? String(source[key]).toLowerCase()
      : fallback;
  const number = (key, fallback, min, max) =>
    Math.min(
      max,
      Math.max(
        min,
        Number.isFinite(Number(source[key])) ? Number(source[key]) : fallback,
      ),
    );
  const font = ["system", "rounded", "serif", "monospaced"].includes(
    source.titleFont,
  )
    ? source.titleFont
    : "system";
  const weight = ["regular", "semibold", "bold", "heavy"].includes(
    source.titleWeight,
  )
    ? source.titleWeight
    : "heavy";
  const alignment = ["leading", "center", "trailing"].includes(
    source.textAlignment,
  )
    ? source.textAlignment
    : "leading";
  return {
    backgroundColor: safeColor("backgroundColor", "#161616"),
    overlayColor: safeColor("overlayColor", "#000000"),
    overlayOpacity: number("overlayOpacity", 0.32, 0, 0.9),
    titleColor: safeColor("titleColor", "#ffffff"),
    messageColor: safeColor("messageColor", "#ffffff"),
    ctaBackgroundColor: safeColor("ctaBackgroundColor", "#ffffff"),
    ctaTextColor: safeColor("ctaTextColor", "#161616"),
    titleFont: font,
    titleWeight: weight,
    titleSize: number("titleSize", 28, 16, 42),
    messageSize: number("messageSize", 13, 10, 24),
    textAlignment: alignment,
  };
}
function itemPayload(body) {
  const fields = [
    "title",
    "message",
    "imageUrl",
    "ctaText",
    "ctaAction",
    "serviceCategory",
    "placement",
    "priority",
    "audience",
    "startsAt",
    "endsAt",
  ];
  const output = Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(body || {}, field))
      .map((field) => [field, body[field]]),
  );
  if (Object.hasOwn(body || {}, "bannerStyle"))
    output.bannerStyle = bannerStyle(body.bannerStyle);
  const start = output.startsAt
    ? new Date(output.startsAt).getTime()
    : -Infinity;
  const end = output.endsAt ? new Date(output.endsAt).getTime() : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    const error = new Error("End time must be after start time");
    error.status = 400;
    throw error;
  }
  return output;
}
async function audit(req, eventName, title, detail, payload = {}) {
  await AdminActivity.create({
    eventName,
    category: "app_control",
    title,
    detail,
    actorRole: "admin",
    actorName: actor(req),
    status: "success",
    payload: { ...payload, app: targetApp(req), platform: targetPlatform(req) },
  });
}
function broadcast(req, eventName, payload = {}) {
  emitAdminEvent(eventName, {
    app: targetApp(req),
    platform: targetPlatform(req),
    ...payload,
  });
}

const customerFeatures = [
  [
    "home_banners",
    "Home banners & announcements",
    "Shows published banners and announcements on the customer home screen.",
  ],
  [
    "booking_history",
    "Booking history",
    "Lets customers access existing booking history.",
  ],
  [
    "commercial_services",
    "Commercial services",
    "Shows the commercial services entry point on the customer home screen.",
  ],
];
const partnerFeatures = [
  ["partner_dashboard", "Partner dashboard", "Partner home dashboard"],
  [
    "partner_booking_management",
    "Booking management",
    "View and manage assigned bookings",
  ],
  ["partner_earnings", "Earnings", "Partner earnings and payout views"],
  ["partner_availability", "Availability", "Online availability controls"],
  ["partner_profile", "Profile", "Partner profile and account details"],
  ["partner_notifications", "Notifications", "Partner notification center"],
  ["partner_support", "Support", "Partner help and support"],
  ["partner_location", "Live location", "Partner location updates"],
  [
    "partner_documents",
    "Document management",
    "Partner document and KYC flows",
  ],
];
async function featureRegistry(app) {
  const source = app === "partner" ? partnerFeatures : customerFeatures;
  await Promise.all(
    source.map(([featureId, name, description]) =>
      FeatureRegistry.updateOne(
        { featureId },
        {
          $setOnInsert: { featureId, name, description, app },
          $set: {
            app,
            implementationState: "active",
            remoteConfigSupported: true,
            lastDiscoveredAt: new Date(),
          },
        },
        { upsert: true },
      ),
    ),
  );
  return FeatureRegistry.find({ app }).sort({ name: 1 }).lean();
}
function validKind(req) {
  const kind = String(req.params.kind || "");
  if (
    !["announcement", "banner"].includes(kind) ||
    (targetApp(req) === "partner" && kind === "banner")
  ) {
    const error = new Error("Unknown content type");
    error.status = 404;
    throw error;
  }
  return kind;
}

function mergedCustomerServices(databaseServices) {
  const catalog = [
    {
      serviceCategory: "commercial",
      name: "Commercial Services",
      description: "Independently control office, shop, hotel and warehouse service enquiries in the iOS customer app."
    },
    ...serviceCatalog()
  ];
  const recordsByCategory = new Map(
    databaseServices.map((service) => [
      normalizeServiceCategory(service.serviceCategory || service.name),
      service,
    ]),
  );
  const catalogCategories = new Set(
    catalog.map((service) => service.serviceCategory),
  );
  const catalogServices = catalog.map((service) => {
    const databaseService = recordsByCategory.get(service.serviceCategory);
    return databaseService
      ? {
          ...service,
          ...databaseService,
          serviceCategory: service.serviceCategory,
        }
      : {
          _id: `catalog:${service.serviceCategory}`,
          ...service,
          isActive: true,
          availability: "AVAILABLE",
          availabilityMessage: "",
          availabilityStartsAt: null,
          availabilityEndsAt: null,
        };
  });
  const additionalServices = databaseServices.filter(
    (service) =>
      !catalogCategories.has(
        normalizeServiceCategory(service.serviceCategory || service.name),
      ),
  );
  return [...catalogServices, ...additionalServices];
}

async function publicConfig(req, res, next) {
  try {
    const app = normalizedApp(req.query.app);
    const platform =
      String(req.query.platform || "android").toLowerCase() === "ios"
        ? "ios"
        : "android";
    res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    const payload = await getPublicAppControlConfig(
      app === "partner" ? "partners" : "users",
      app,
      platform,
    );
    payload.appType = app === "partner" ? "PARTNER" : "USER";
    payload.platform = platform.toUpperCase();
    payload.configVersion = String(payload.version || 0);
    payload.config.update = payload.config.update?.platforms?.[platform] || {};
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
}
async function overview(req, res, next) {
  try {
    const app = targetApp(req);
    const platform = targetPlatform(req);
    const doc = await AppControlConfig.findOne({ key: configKey(req) }).lean();
    const filter = contentFilter(app, platform);
    const [
      announcements,
      banners,
      auditLogs,
      databaseServices,
      features,
      activePartners,
    ] = await Promise.all([
      AppControlItem.countDocuments({
        ...filter,
        kind: "announcement",
        status: { $in: ["published", "scheduled"] },
      }),
      app === "partner"
        ? 0
        : AppControlItem.countDocuments({
            ...filter,
            kind: "banner",
            status: { $in: ["published", "scheduled"] },
          }),
      AdminActivity.countDocuments({
        category: "app_control",
        "payload.app": app,
        "payload.platform": platform,
      }),
      app === "customer"
        ? Service.find(
            {},
            {
              serviceCategory: 1,
              name: 1,
              description: 1,
              isActive: 1,
              availability: 1,
              availabilityMessage: 1,
              availabilityStartsAt: 1,
              availabilityEndsAt: 1,
            },
          )
            .sort({ name: 1 })
            .limit(250)
            .lean()
        : [],
      featureRegistry(app),
      app === "partner"
        ? Partner.countDocuments({ accountStatus: "active" })
        : 0,
    ]);
    return res.json({
      app,
      platform,
      draft: normalizeConfig(doc?.draft),
      published: normalizeConfig(doc?.published),
      version: Number(doc?.version || 0),
      updatedAt: doc?.updatedAt || null,
      publishedAt: doc?.publishedAt || null,
      publishedBy: doc?.publishedBy || "",
      counts: { announcements, banners, auditLogs, activePartners },
      services:
        app === "customer" ? mergedCustomerServices(databaseServices) : [],
      features,
    });
  } catch (error) {
    return next(error);
  }
}
async function saveDraft(req, res, next) {
  try {
    assertSuperAdmin(req);
    const section = String(req.body?.section || "").trim();
    let patch = req.body?.value;
    if (!section || !isObject(patch))
      return res
        .status(400)
        .json({ message: "section and object value are required" });
    if (
      targetApp(req) === "partner" &&
      ["launch", "services", "media"].includes(section)
    )
      return res
        .status(400)
        .json({ message: "This control is not supported for the Partner App" });
    if (section === "services") {
      const knownCategories = new Set(
        serviceCatalog().map((service) => service.serviceCategory),
      );
      const normalizedEntries = Object.entries(patch).map(
        ([category, value]) => [normalizeServiceCategory(category), value],
      );
      if (
        normalizedEntries.some(([category]) => !knownCategories.has(category))
      )
        return res
          .status(400)
          .json({
            message: "Only implemented customer services can be controlled",
          });
      patch = Object.fromEntries(normalizedEntries);
    }
    if (section === "media") {
      const knownCategories = new Set(
        serviceCatalog().map((service) => service.serviceCategory),
      );
      const normalizeMediaEntries = (value) =>
        Object.entries(isObject(value) ? value : {}).map(
          ([category, entry]) => [
            normalizeServiceCategory(category),
            isObject(entry) ? { imageUrl: entry.imageUrl } : { imageUrl: "" },
          ],
        );
      const serviceEntries = normalizeMediaEntries(patch.services);
      const heroSlides = normalizeMediaEntries(patch.hero?.slides);
      if (
        [...serviceEntries, ...heroSlides].some(
          ([category]) => !knownCategories.has(category),
        )
      )
        return res
          .status(400)
          .json({
            message: "Only implemented customer service media can be changed",
          });
      patch = {
        hero: isObject(patch.hero)
          ? {
              imageUrl: patch.hero.imageUrl,
              slides: Object.fromEntries(heroSlides),
            }
          : { imageUrl: "", slides: {} },
        services: Object.fromEntries(serviceEntries),
      };
    }
    if (section === "update") patch = managedCustomerUpdate(patch);
    const current = await AppControlConfig.findOne({
      key: configKey(req),
    }).lean();
    const draft = normalizeConfig(merge(current?.draft, { [section]: patch }));
    const updated = await AppControlConfig.findOneAndUpdate(
      { key: configKey(req) },
      { $set: { draft, updatedBy: actor(req) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await audit(req, "app_control:draft_saved", "Draft saved", section, {
      section,
    });
    broadcast(req, "app_control:draft_saved", { section });
    return res.json({
      draft: normalizeConfig(updated.draft),
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    return next(error);
  }
}
async function uploadMedia(req, res, next) {
  try {
    assertSuperAdmin(req);
    if (targetApp(req) !== "customer")
      return res
        .status(400)
        .json({
          message: "Customer media is only supported for the Customer App",
        });
    if (!req.file)
      return res.status(400).json({ message: "An image file is required" });
    const file = req.file;
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      const result = await uploadMediaToCloudinary(file);
      const asset = await AppControlMediaAsset.create({
        mimeType: file.mimetype,
        originalName: file.originalname || "app-control-image",
        sizeBytes: file.size,
        storageProvider: "cloudinary",
        url: result.secure_url,
        publicId: result.public_id,
        createdBy: actor(req),
      });
      await audit(req, "media:uploaded", "Media uploaded", asset.originalName, {
        assetId: String(asset._id),
        storageProvider: asset.storageProvider,
      });
      return res
        .status(201)
        .json({
          imageUrl: asset.url,
          assetId: String(asset._id),
          storageProvider: asset.storageProvider,
        });
    }
    const asset = await AppControlMediaAsset.create({
      mimeType: file.mimetype,
      originalName: file.originalname || "app-control-image",
      sizeBytes: file.size,
      storageProvider: "mongodb",
      dataBase64: file.buffer.toString("base64"),
      createdBy: actor(req),
    });
    const imageUrl = `${publicBaseUrl(req)}/api/admin/control-center/media/assets/${asset._id}`;
    await audit(req, "media:uploaded", "Media uploaded", asset.originalName, {
      assetId: String(asset._id),
      storageProvider: asset.storageProvider,
    });
    return res
      .status(201)
      .json({
        imageUrl,
        assetId: String(asset._id),
        storageProvider: asset.storageProvider,
      });
  } catch (error) {
    return next(error);
  }
}
async function mediaAsset(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.assetId)) {
      return res.status(404).json({ message: "Media asset not found" });
    }
    const asset = await AppControlMediaAsset.findById(
      req.params.assetId,
    ).lean();
    if (!asset || asset.storageProvider !== "mongodb" || !asset.dataBase64)
      return res.status(404).json({ message: "Media asset not found" });
    res.set("Content-Type", asset.mimeType);
    res.set("Cache-Control", "public, max-age=2592000, immutable");
    return res.send(Buffer.from(asset.dataBase64, "base64"));
  } catch (error) {
    return next(error);
  }
}
async function publish(req, res, next) {
  try {
    assertSuperAdmin(req);
    const app = targetApp(req);
    const platform = targetPlatform(req);
    const current = await AppControlConfig.findOne({ key: configKey(req) });
    if (!current)
      return res
        .status(409)
        .json({ message: "Save a draft before publishing" });
    const previous = normalizeConfig(current.published);
    const published = normalizeConfig(current.draft);
    current.published = published;
    current.publishedAt = new Date();
    current.publishedBy = actor(req);
    current.updatedBy = actor(req);
    current.version = Number(current.version || 0) + 1;
    await current.save();
    if (app === "customer" && platform === "android")
      await Promise.all(
        Object.entries(published.services).map(([serviceCategory, value]) =>
          Service.updateMany(
            {
              serviceCategory: {
                $in: serviceCategoryVariants(serviceCategory),
              },
            },
            {
              $set: {
                availability: value.status,
                availabilityMessage: value.message,
                availabilityStartsAt: value.startsAt || null,
                availabilityEndsAt: value.endsAt || null,
              },
            },
          ),
        ),
      );
    await AppControlItem.updateMany(
      { ...contentFilter(app, platform), status: { $in: ["draft", "scheduled"] } },
      { $set: { status: "published", updatedBy: actor(req) } },
    );
    invalidatePublishedConfig(app, platform);
    await audit(
      req,
      "app_control:published",
      "Configuration published",
      `${app} application configuration updated`,
      { previous, published, version: current.version },
    );
    broadcast(req, "app_control:published", { version: current.version });
    return res.json({
      ok: true,
      version: current.version,
      published,
      publishedAt: current.publishedAt,
    });
  } catch (error) {
    return next(error);
  }
}
async function openBookings(req, res, next) {
  try {
    assertSuperAdmin(req);
    if (targetApp(req) !== "customer")
      return res
        .status(400)
        .json({
          message: "Opening customer bookings is not a Partner App control",
        });
    const current = await AppControlConfig.findOne({ key: configKey(req) });
    const previous = normalizeConfig(current?.published);
    const published = normalizeConfig(
      merge(current?.draft, {
        appStatus: { mode: "LIVE" },
        launch: { enabled: false },
      }),
    );
    const updated = await AppControlConfig.findOneAndUpdate(
      { key: configKey(req) },
      {
        $set: {
          draft: published,
          published,
          publishedAt: new Date(),
          publishedBy: actor(req),
          updatedBy: actor(req),
        },
        $inc: { version: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    invalidatePublishedConfig("customer", targetPlatform(req));
    await audit(
      req,
      "app_control:bookings_opened",
      "Launch screen removed",
      "Customer booking flow opened manually",
      { previous, published, version: updated.version },
    );
    broadcast(req, "app_control:published", { version: updated.version });
    return res.json({ ok: true, version: updated.version, published });
  } catch (error) {
    return next(error);
  }
}
async function rollback(req, res, next) {
  try {
    assertSuperAdmin(req);
    const app = targetApp(req);
    const platform = targetPlatform(req);
    const activity = await AdminActivity.findOne({
      _id: req.params.activityId,
      category: "app_control",
      eventName: "app_control:published",
      "payload.app": app,
      "payload.platform": platform,
    }).lean();
    if (!activity?.payload?.previous)
      return res
        .status(404)
        .json({ message: "Published configuration snapshot not found" });
    const restored = normalizeConfig(activity.payload.previous);
    const current = await AppControlConfig.findOneAndUpdate(
      { key: configKey(req) },
      {
        $set: {
          draft: restored,
          published: restored,
          publishedAt: new Date(),
          publishedBy: actor(req),
          updatedBy: actor(req),
        },
        $inc: { version: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    invalidatePublishedConfig(app, platform);
    await audit(
      req,
      "app_control:rolled_back",
      "Configuration rolled back",
      `Restored snapshot from ${activity.createdAt.toISOString()}`,
      {
        restoredFrom: String(activity._id),
        published: restored,
        version: current.version,
      },
    );
    broadcast(req, "app_control:published", { version: current.version });
    return res.json({
      ok: true,
      version: current.version,
      published: restored,
    });
  } catch (error) {
    return next(error);
  }
}
async function saveServiceAvailability(req, res, next) {
  try {
    assertSuperAdmin(req);
    if (targetApp(req) !== "customer")
      return res
        .status(400)
        .json({ message: "Service availability is a Customer App control" });
    const category = normalizeServiceCategory(req.params.category);
    if (
      !category ||
      category.length > 80 ||
      !serviceCatalog().some((service) => service.serviceCategory === category)
    )
      return res
        .status(400)
        .json({ message: "A valid implemented service category is required" });
    const config = normalizeConfig({ services: { [category]: req.body || {} } })
      .services[category];
    const current = await AppControlConfig.findOne({
      key: configKey(req),
    }).lean();
    const draft = normalizeConfig(
      merge(current?.draft, { services: { [category]: config } }),
    );
    await AppControlConfig.findOneAndUpdate(
      { key: configKey(req) },
      { $set: { draft, updatedBy: actor(req) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await audit(
      req,
      "service:availability_saved",
      "Service availability saved",
      `${category}: ${config.status}`,
      { category, ...config },
    );
    return res.json({ category, config, draft });
  } catch (error) {
    return next(error);
  }
}
async function resetDraft(req, res, next) {
  try {
    assertSuperAdmin(req);
    const current = await AppControlConfig.findOne({ key: configKey(req) });
    if (!current) return res.json({ ok: true, draft: normalizeConfig({}) });
    current.draft = normalizeConfig(current.published);
    current.updatedBy = actor(req);
    await current.save();
    await audit(
      req,
      "app_control:draft_reset",
      "Draft reset",
      "Draft restored to published configuration",
    );
    return res.json({ ok: true, draft: normalizeConfig(current.draft) });
  } catch (error) {
    return next(error);
  }
}
async function listItems(req, res, next) {
  try {
    const kind = validKind(req);
    const app = targetApp(req);
    const status = String(req.query.status || "");
    const search = String(req.query.search || "").trim();
    const filter = {
      ...contentFilter(app, targetPlatform(req)),
      kind,
      ...(status ? { status } : {}),
      ...(search
        ? {
            title: new RegExp(
              search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "i",
            ),
          }
        : {}),
    };
    const items = await AppControlItem.find(filter)
      .sort({ priority: 1, createdAt: -1 })
      .limit(Math.min(Number(req.query.limit || 100), 250))
      .lean();
    return res.json({ items, now: new Date().toISOString() });
  } catch (error) {
    return next(error);
  }
}
async function createItem(req, res, next) {
  try {
    assertSuperAdmin(req);
    const kind = validKind(req);
    const body = itemPayload(req.body);
    if (!String(body.title || "").trim())
      return res.status(400).json({ message: "Title is required" });
    const item = await AppControlItem.create({
      ...body,
      app: targetApp(req),
      platform: targetPlatform(req),
      kind,
      status: "draft",
      createdBy: actor(req),
      updatedBy: actor(req),
    });
    await audit(req, `${kind}:created`, `${kind} created`, item.title, {
      id: String(item._id),
    });
    return res.status(201).json({ item });
  } catch (error) {
    return next(error);
  }
}
async function updateItem(req, res, next) {
  try {
    assertSuperAdmin(req);
    const kind = validKind(req);
    const item = await AppControlItem.findOneAndUpdate(
      { _id: req.params.id, kind, ...contentFilter(targetApp(req), targetPlatform(req)) },
      {
        $set: {
          ...itemPayload(req.body),
          status: "draft",
          updatedBy: actor(req),
        },
      },
      { new: true, runValidators: true },
    );
    if (!item) return res.status(404).json({ message: "Content not found" });
    await audit(req, `${kind}:updated`, `${kind} updated`, item.title, {
      id: String(item._id),
    });
    return res.json({ item });
  } catch (error) {
    return next(error);
  }
}
async function deleteItem(req, res, next) {
  try {
    assertSuperAdmin(req);
    const item = await AppControlItem.findOneAndDelete({
      _id: req.params.id,
      kind: req.params.kind,
      ...contentFilter(targetApp(req), targetPlatform(req)),
    });
    if (!item) return res.status(404).json({ message: "Content not found" });
    await audit(
      req,
      `${item.kind}:deleted`,
      `${item.kind} deleted`,
      item.title,
      { id: String(item._id) },
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}
async function auditLogs(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 250);
    const logs = await AdminActivity.find({
      category: "app_control",
      "payload.app": targetApp(req),
      "payload.platform": targetPlatform(req),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ logs });
  } catch (error) {
    return next(error);
  }
}
module.exports = {
  publicConfig,
  overview,
  saveDraft,
  publish,
  openBookings,
  rollback,
  resetDraft,
  saveServiceAvailability,
  uploadMedia,
  mediaAsset,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  auditLogs,
};
