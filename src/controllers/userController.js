const { z } = require("zod");
const User = require("../models/User");

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  fcmToken: z.string().optional()
});

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Customer",
      phone: body.phone || req.auth.phone_number || "",
      email: body.email || req.auth.email || "",
      address: body.address || "",
      city: body.city || "Guwahati"
    };

    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
      update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    }

    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ user });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
}

async function saveFcmToken(req, res, next) {
  try {
    const token = String(req.body?.fcmToken || "");
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { fcmToken: token } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({ ok: true, userId: user._id });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  upsertProfile,
  me,
  saveFcmToken
};
