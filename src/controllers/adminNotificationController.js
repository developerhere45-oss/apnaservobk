const { z } = require("zod");
const crypto = require("crypto");
const { Readable } = require("stream");
const mongoose = require("mongoose");
const AdminNotification = require("../models/AdminNotification");
const AdminNotificationAsset = require("../models/AdminNotificationAsset");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { cloudinary } = require("../config/cloudinary");
const { deliverAdminNotification, resolveRecipients } = require("../utils/adminNotificationDelivery");
const { emitAdminEvent } = require("../sockets/bookingSocket");

const targetTypes = ["ALL_USERS", "ALL_PARTNERS", "SPECIFIC_USER", "SPECIFIC_PARTNER"];
const actionTypes = ["NONE", "OPEN_HOME", "OPEN_NOTIFICATIONS", "OPEN_SERVICE", "OPEN_BOOKING", "OPEN_OFFERS", "OPEN_PARTNER_HOME", "OPEN_PARTNER_BOOKING"];

const notificationPayloadSchema = z.object({
  title: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(500),
  imageUrl: z.string().trim().max(2500).optional().or(z.literal("")),
  targetType: z.enum(targetTypes),
  targetUserIds: z.array(z.string().trim().min(1)).max(50).optional(),
  targetPartnerIds: z.array(z.string().trim().min(1)).max(50).optional(),
  recipientId: z.string().trim().max(80).optional(),
  recipientQuery: z.string().trim().max(180).optional(),
  actionType: z.enum(actionTypes).default("NONE"),
  actionId: z.string().trim().max(160).optional().or(z.literal("")),
  scheduleAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().max(160).optional()
});

function serialize(notification) {
  return {
    id: String(notification._id),
    title: notification.title,
    message: notification.message,
    imageUrl: notification.imageUrl || "",
    targetType: notification.targetType,
    targetUserIds: (notification.targetUserIds || []).map(String),
    targetPartnerIds: (notification.targetPartnerIds || []).map(String),
    actionType: notification.actionType,
    actionId: notification.actionId || "",
    status: notification.status,
    scheduleAt: notification.scheduleAt ? notification.scheduleAt.toISOString() : "",
    sentAt: notification.sentAt ? notification.sentAt.toISOString() : "",
    sentBy: notification.sentBy,
    sentByEmail: notification.sentByEmail,
    recipientCount: notification.recipientCount,
    successCount: notification.successCount,
    failureCount: notification.failureCount,
    invalidTokenCount: notification.invalidTokenCount,
    errorMessages: notification.errorMessages || [],
    idempotencyKey: notification.idempotencyKey || "",
    createdAt: notification.createdAt ? notification.createdAt.toISOString() : "",
    updatedAt: notification.updatedAt ? notification.updatedAt.toISOString() : ""
  };
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (configured) return configured;
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  if (!host) return "";
  return `${host.includes("onrender.com") ? "https" : proto}://${host}`;
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || "").trim());
}

function normalizeNotificationImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const imgUrl = parsed.searchParams.get("imgurl");
    if (imgUrl && isHttpUrl(imgUrl)) return imgUrl;
  } catch {
    return "";
  }
  return isHttpUrl(raw) ? raw : "";
}

function adminIdentity(req) {
  return {
    sentBy: req.auth?.uid || "admin-dashboard",
    sentByEmail: req.auth?.email || "admin-dashboard@apnaservo.internal"
  };
}

function targetIds(body) {
  const targetUserIds = [...(body.targetUserIds || [])];
  const targetPartnerIds = [...(body.targetPartnerIds || [])];
  if (body.targetType === "SPECIFIC_USER" && body.recipientId) targetUserIds.push(body.recipientId);
  if (body.targetType === "SPECIFIC_PARTNER" && body.recipientId) targetPartnerIds.push(body.recipientId);
  return {
    targetUserIds: [...new Set(targetUserIds.filter(Boolean))],
    targetPartnerIds: [...new Set(targetPartnerIds.filter(Boolean))]
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function identityHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const secret = process.env.IDENTITY_HASH_PEPPER || process.env.ENCRYPTION_KEY || "apnaservo-dev-identity-hash";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

function matchesRecipient(record, q) {
  const clean = String(q || "").trim().toLowerCase();
  if (!clean) return true;
  const phone = normalizePhone(clean);
  return [
    record.name,
    record.phone,
    record.email,
    record.partnerCode,
    String(record._id || "")
  ].some((value) => String(value || "").toLowerCase().includes(clean))
    || (phone.length === 10 && normalizePhone(record.phone) === phone);
}

async function resolveRecipientIdsFromQuery(body) {
  const query = String(body.recipientQuery || "").trim();
  if (!query || !["SPECIFIC_USER", "SPECIFIC_PARTNER"].includes(body.targetType)) {
    return [];
  }
  const isPartner = body.targetType === "SPECIFIC_PARTNER";
  const Model = isPartner ? Partner : User;
  const filters = [];
  const phone = normalizePhone(query);
  const email = normalizeEmail(query);
  if (mongoose.Types.ObjectId.isValid(query)) filters.push({ _id: query });
  if (phone.length === 10) filters.push({ phoneHash: identityHash(phone) });
  if (email.includes("@")) filters.push({ emailHash: identityHash(email) });
  if (isPartner) {
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filters.push({ partnerCode: regex });
  }

  let records = filters.length
    ? await Model.find({ $or: filters }).select("_id name phone email partnerCode accountStatus trustStatus").limit(5)
    : [];

  if (!records.length) {
    const candidates = await Model.find()
      .select("_id name phone email partnerCode accountStatus trustStatus")
      .sort({ createdAt: -1 })
      .limit(1000);
    records = candidates.filter((record) => matchesRecipient(record, query)).slice(0, 5);
  }
  return records.map((record) => String(record._id));
}

async function validateTarget(body) {
  const ids = targetIds(body);
  if (body.targetType === "SPECIFIC_USER" && !ids.targetUserIds.length) {
    const resolved = await resolveRecipientIdsFromQuery(body);
    if (resolved.length > 1) throw new Error("Multiple users matched. Select the exact recipient from search results");
    ids.targetUserIds = resolved;
  }
  if (body.targetType === "SPECIFIC_PARTNER" && !ids.targetPartnerIds.length) {
    const resolved = await resolveRecipientIdsFromQuery(body);
    if (resolved.length > 1) throw new Error("Multiple partners matched. Select the exact recipient from search results");
    ids.targetPartnerIds = resolved;
  }
  if (body.targetType === "SPECIFIC_USER" && !ids.targetUserIds.length) {
    throw new Error("Specific user target requires a selected user");
  }
  if (body.targetType === "SPECIFIC_PARTNER" && !ids.targetPartnerIds.length) {
    throw new Error("Specific partner target requires a selected partner");
  }
  const selectedIds = body.targetType === "SPECIFIC_USER" ? ids.targetUserIds
    : body.targetType === "SPECIFIC_PARTNER" ? ids.targetPartnerIds
      : [];
  if (selectedIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new Error("Selected recipient ID is invalid");
  }
  if (["OPEN_SERVICE", "OPEN_BOOKING", "OPEN_PARTNER_BOOKING"].includes(body.actionType) && !String(body.actionId || "").trim()) {
    throw new Error(`${body.actionType} requires actionId`);
  }
  return ids;
}

async function existingByIdempotency(key) {
  if (!key) return null;
  return AdminNotification.findOne({ idempotencyKey: key });
}

async function createNotification(body, req, status) {
  const ids = await validateTarget(body);
  const idempotencyKey = body.idempotencyKey || req.get("idempotency-key") || "";
  const existing = await existingByIdempotency(idempotencyKey);
  if (existing) return { notification: existing, existing: true };
  const imageUrl = normalizeNotificationImageUrl(body.imageUrl);
  try {
    const notification = await AdminNotification.create({
      title: body.title,
      message: body.message,
      imageUrl,
      targetType: body.targetType,
      targetUserIds: ids.targetUserIds,
      targetPartnerIds: ids.targetPartnerIds,
      actionType: body.actionType || "NONE",
      actionId: body.actionId || "",
      status,
      scheduleAt: body.scheduleAt || null,
      idempotencyKey,
      ...adminIdentity(req)
    });
    return { notification, existing: false };
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const raced = await existingByIdempotency(idempotencyKey);
      if (raced) return { notification: raced, existing: true };
    }
    throw error;
  }
}

async function send(req, res, next) {
  try {
    const parsed = notificationPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid notification payload", issues: parsed.error.issues });
    parsed.data.imageUrl = normalizeNotificationImageUrl(parsed.data.imageUrl || "");
    const { notification, existing } = await createNotification(parsed.data, req, "draft");
    if (!existing) {
      emitAdminEvent("notification:created", { notificationId: String(notification._id), title: notification.title, targetType: notification.targetType });
    }
    const delivered = notification.status === "draft"
      ? await deliverAdminNotification(notification)
      : notification;
    return res.json({ notification: serialize(delivered), existing });
  } catch (error) {
    if (error.message.includes("requires") || error.message.includes("invalid") || error.message.includes("Multiple")) return res.status(400).json({ message: error.message });
    return next(error);
  }
}

async function schedule(req, res, next) {
  try {
    const parsed = notificationPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid notification payload", issues: parsed.error.issues });
    parsed.data.imageUrl = normalizeNotificationImageUrl(parsed.data.imageUrl || "");
    if (!parsed.data.scheduleAt || parsed.data.scheduleAt.getTime() <= Date.now() + 60 * 1000) {
      return res.status(400).json({ message: "Schedule date/time must be at least 1 minute in the future" });
    }
    const { notification, existing } = await createNotification(parsed.data, req, "scheduled");
    if (!existing) {
      emitAdminEvent("notification:scheduled", {
        notificationId: String(notification._id),
        title: notification.title,
        targetType: notification.targetType,
        scheduleAt: notification.scheduleAt
      });
    }
    return res.json({ notification: serialize(notification), existing });
  } catch (error) {
    if (error.message.includes("requires") || error.message.includes("invalid") || error.message.includes("Multiple")) return res.status(400).json({ message: error.message });
    return next(error);
  }
}

async function history(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const [notifications, totalNotifications, sentToday, scheduled, failed] = await Promise.all([
      AdminNotification.find().sort({ createdAt: -1 }).limit(limit),
      AdminNotification.countDocuments(),
      AdminNotification.countDocuments({ sentAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      AdminNotification.countDocuments({ status: "scheduled" }),
      AdminNotification.countDocuments({ status: "failed", recipientCount: 0 })
    ]);
    return res.json({
      metrics: { totalNotifications, sentToday, scheduled, failed },
      notifications: notifications.map(serialize)
    });
  } catch (error) {
    return next(error);
  }
}

async function details(req, res, next) {
  try {
    const notification = await AdminNotification.findById(req.params.notificationId);
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    return res.json({ notification: serialize(notification) });
  } catch (error) {
    return next(error);
  }
}

async function remove(req, res, next) {
  try {
    const notification = await AdminNotification.findById(req.params.notificationId);
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    if (notification.status === "scheduled" || notification.status === "draft" || notification.status === "cancelled") {
      await notification.deleteOne();
      emitAdminEvent("notification:deleted", { notificationId: String(notification._id), title: notification.title, status: notification.status });
      return res.json({ ok: true });
    }
    return res.status(409).json({ message: "Only draft, scheduled, or cancelled notifications can be deleted" });
  } catch (error) {
    return next(error);
  }
}

async function cancel(req, res, next) {
  try {
    const notification = await AdminNotification.findOneAndUpdate(
      { _id: req.params.notificationId, status: "scheduled" },
      { $set: { status: "cancelled" } },
      { new: true }
    );
    if (!notification) {
      return res.status(409).json({ message: "Only scheduled notifications can be cancelled" });
    }
    emitAdminEvent("notification:cancelled", {
      notificationId: String(notification._id),
      title: notification.title,
      targetType: notification.targetType
    });
    return res.json({ notification: serialize(notification) });
  } catch (error) {
    return next(error);
  }
}

async function resend(req, res, next) {
  try {
    const source = await AdminNotification.findById(req.params.notificationId);
    if (!source) return res.status(404).json({ message: "Notification not found" });
    const clone = await AdminNotification.create({
      title: source.title,
      message: source.message,
      imageUrl: source.imageUrl,
      targetType: source.targetType,
      targetUserIds: source.targetUserIds,
      targetPartnerIds: source.targetPartnerIds,
      actionType: source.actionType,
      actionId: source.actionId,
      status: "draft",
      metadata: { resendOf: String(source._id) },
      ...adminIdentity(req)
    });
    const delivered = await deliverAdminNotification(clone);
    return res.json({ notification: serialize(delivered) });
  } catch (error) {
    return next(error);
  }
}

async function searchRecipients(req, res, next) {
  try {
    const targetType = String(req.query.targetType || req.query.type || "SPECIFIC_USER").toUpperCase();
    const countOnly = String(req.query.countOnly || "") === "true";
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 12), 30);

    if (countOnly && ["ALL_USERS", "ALL_PARTNERS"].includes(targetType)) {
      const fake = new AdminNotification({ targetType, title: "count", message: "count" });
      const recipients = await resolveRecipients(fake);
      return res.json({ count: recipients.length, results: [] });
    }

    const isPartner = targetType.includes("PARTNER");
    const Model = isPartner ? Partner : User;
    const phone = normalizePhone(q);
    const email = normalizeEmail(q);
    const regex = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    const queryFilters = [];
    if (q.match(/^[a-f0-9]{24}$/i)) queryFilters.push({ _id: q });
    if (phone.length === 10) queryFilters.push({ phoneHash: identityHash(phone) });
    if (email.includes("@")) queryFilters.push({ emailHash: identityHash(email) });
    if (isPartner && regex) queryFilters.push({ partnerCode: regex });
    const filters = queryFilters.length ? { $or: queryFilters } : {};
    let records = q && !queryFilters.length
      ? []
      : await Model.find(filters)
        .select("_id name phone email partnerCode accountStatus trustStatus")
        .sort({ createdAt: -1 })
        .limit(limit);
    if (q && records.length < limit) {
      const candidates = await Model.find()
        .select("_id name phone email partnerCode accountStatus trustStatus")
        .sort({ createdAt: -1 })
        .limit(1000);
      const seen = new Set(records.map((record) => String(record._id)));
      const fallback = candidates
        .filter((record) => !seen.has(String(record._id)) && matchesRecipient(record, q))
        .slice(0, Math.max(limit - records.length, 0));
      records = [...records, ...fallback];
    }
    return res.json({
      count: records.length,
      results: records.map((record) => ({
        id: String(record._id),
        type: isPartner ? "partner" : "user",
        name: record.name || "",
        phone: record.phone || "",
        email: record.email || "",
        code: record.partnerCode || "",
        status: record.accountStatus || record.trustStatus || "active"
      }))
    });
  } catch (error) {
    return next(error);
  }
}

function uploadBufferToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "apnaservo/admin-notifications",
        resource_type: "image",
        overwrite: false
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );
    Readable.from(file.buffer).pipe(stream);
  });
}

async function uploadImage(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "Image file is required" });
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      const asset = await AdminNotificationAsset.create({
        mimeType: req.file.mimetype,
        originalName: req.file.originalname || "notification-image",
        sizeBytes: req.file.size,
        dataBase64: req.file.buffer.toString("base64"),
        createdBy: req.auth?.uid || "admin-dashboard"
      });
      const baseUrl = publicBaseUrl(req);
      return res.json({
        imageUrl: `${baseUrl}/api/admin/notifications/assets/${asset._id}`,
        publicId: String(asset._id),
        storageProvider: "mongodb"
      });
    }
    const result = await uploadBufferToCloudinary(req.file);
    return res.json({ imageUrl: result.secure_url, publicId: result.public_id });
  } catch (error) {
    return next(error);
  }
}

async function asset(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.assetId || ""))) {
      return res.status(404).json({ message: "Asset not found" });
    }
    const record = await AdminNotificationAsset.findById(req.params.assetId).lean();
    if (!record) return res.status(404).json({ message: "Asset not found" });
    const buffer = Buffer.from(record.dataBase64 || "", "base64");
    res.set("Content-Type", record.mimeType);
    res.set("Cache-Control", "public, max-age=2592000, immutable");
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  send,
  schedule,
  history,
  details,
  remove,
  cancel,
  resend,
  searchRecipients,
  uploadImage,
  asset
};
