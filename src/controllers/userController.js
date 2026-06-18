const { z } = require("zod");
const User = require("../models/User");

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(180).optional().or(z.literal("")),
  address: z.string().trim().max(700).optional(),
  city: z.string().trim().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  fcmToken: z.string().trim().max(4096).optional()
});

const deletionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function tokenPhoneVerified(req, phone) {
  const tokenPhone = normalizePhone(req.auth?.phone_number);
  const profilePhone = normalizePhone(phone);
  return tokenPhone.length === 10 && profilePhone.length === 10 && tokenPhone === profilePhone;
}

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const phone = body.phone || req.auth.phone_number || "";
    const verified = tokenPhoneVerified(req, phone);
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Customer",
      phone,
      email: body.email || req.auth.email || "",
      address: body.address || "",
      city: body.city || "Guwahati",
      bookingRiskStatus: verified ? "trusted" : "otp_required"
    };

    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (verified) {
      update.phoneVerified = true;
      update.phoneVerifiedAt = new Date();
    } else {
      update.phoneVerified = false;
      update.phoneVerifiedAt = null;
    }
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
    const token = String(req.body?.fcmToken || "").trim();
    if (!token || token.length > 4096) {
      return res.status(400).json({ message: "Valid FCM token is required" });
    }
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

async function requestDeletion(req, res, next) {
  try {
    const body = deletionRequestSchema.parse(req.body || {});
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $set: {
          accountStatus: "deletion_requested",
          deletionRequestedAt: new Date(),
          deletionReason: body.reason || "Customer requested account deletion from Android app",
          fcmToken: ""
        },
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          name: req.auth.name || "ApnaServo Customer",
          phone: req.auth.phone_number || "",
          email: req.auth.email || "",
          city: "Guwahati"
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({
      ok: true,
      accountStatus: user.accountStatus,
      deletionRequestedAt: user.deletionRequestedAt
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  upsertProfile,
  me,
  saveFcmToken,
  requestDeletion
};
