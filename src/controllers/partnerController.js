const { z } = require("zod");
const Partner = require("../models/Partner");
const { normalizeServiceCategory } = require("../utils/serviceCategory");

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  serviceCategory: z.union([z.string(), z.array(z.string())]).optional(),
  city: z.string().optional(),
  serviceArea: z.string().optional(),
  serviceRadiusKm: z.number().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  isOnline: z.boolean().optional(),
  fcmToken: z.string().optional(),
  photoUrl: z.string().optional()
});

function categoriesFrom(bodyValue) {
  const values = Array.isArray(bodyValue) ? bodyValue : [bodyValue || "ac"];
  return [...new Set(values.map(normalizeServiceCategory).filter(Boolean))];
}

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Partner",
      phone: body.phone || req.auth.phone_number || "",
      email: body.email || req.auth.email || "",
      serviceCategory: categoriesFrom(body.serviceCategory),
      city: body.city || "Guwahati",
      serviceArea: body.serviceArea || "Guwahati, Assam",
      serviceRadiusKm: body.serviceRadiusKm || 25,
      isOnline: body.isOnline !== false,
      isVerified: true
    };

    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (body.photoUrl) update.photoUrl = body.photoUrl;
    if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
      update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    }

    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: update, $setOnInsert: { partnerCode: `ASP${Date.now().toString().slice(-7)}` } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function saveFcmToken(req, res, next) {
  try {
    const token = String(req.body?.fcmToken || "");
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { fcmToken: token } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({ ok: true, partnerId: partner._id });
  } catch (error) {
    return next(error);
  }
}

async function setOnline(req, res, next) {
  try {
    const isOnline = req.path.includes("online");
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { isOnline } },
      { new: true }
    );
    return res.json({ ok: true, partner });
  } catch (error) {
    return next(error);
  }
}

async function updateLocation(req, res, next) {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { location: { type: "Point", coordinates: [lng, lat] } } },
      { new: true }
    );
    return res.json({ ok: true, partner });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  upsertProfile,
  me,
  saveFcmToken,
  setOnline,
  updateLocation
};
