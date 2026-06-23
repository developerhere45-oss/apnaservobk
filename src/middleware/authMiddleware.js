const { admin } = require("../config/firebase");
const User = require("../models/User");
const Partner = require("../models/Partner");

function csvSet(value, options = {}) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => {
      const trimmed = item.trim();
      return options.lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean));
}

function developmentDeviceAuth(req) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEV_DEVICE_AUTH !== "true") {
    return null;
  }

  const uid = String(req.headers["x-apnaservo-dev-uid"] || "").trim();
  const role = String(req.headers["x-apnaservo-dev-role"] || "").trim().toLowerCase();
  if (!/^(local-user|local-partner)-[a-zA-Z0-9._:-]{6,160}$/.test(uid)) {
    return null;
  }
  if (!["user", "partner"].includes(role) || !uid.startsWith(`local-${role}-`)) {
    return null;
  }

  return {
    uid,
    role,
    email_verified: false,
    development_device: true
  };
}

async function verifyFirebaseToken(req, res, next) {
  try {
    const developmentAuth = developmentDeviceAuth(req);
    if (developmentAuth) {
      req.auth = developmentAuth;
      req.authType = "development_device";
      return next();
    }

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ message: "Firebase ID token missing" });
    }

    const checkRevoked = process.env.NODE_ENV === "production";
    const decoded = await admin.auth().verifyIdToken(token, checkRevoked);
    if (!decoded.uid) {
      return res.status(401).json({ message: "Invalid Firebase token" });
    }
    req.auth = decoded;
    req.authType = "firebase_jwt";
    return next();
  } catch (error) {
    const payload = { message: "Invalid Firebase token" };
    if (process.env.NODE_ENV !== "production") {
      payload.detail = error.message;
    }
    return res.status(401).json(payload);
  }
}

async function attachUser(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }
    req.userProfile = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function attachPartner(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    req.partnerProfile = partner;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  const allowedUids = csvSet(process.env.ADMIN_FIREBASE_UIDS);
  const allowedEmails = csvSet(process.env.ADMIN_EMAILS, { lowercase: true });
  if (!allowedUids.size && !allowedEmails.size) {
    return res.status(403).json({ message: "Admin access is not configured" });
  }
  const uidAllowed = allowedUids.has(req.auth.uid);
  const emailAllowed = req.auth.email_verified === true
    && req.auth.email
    && allowedEmails.has(String(req.auth.email).toLowerCase());

  if (!uidAllowed && !emailAllowed) {
    return res.status(403).json({ message: "Admin access required" });
  }
  return next();
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return require("crypto").timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyAdminSecret(req, res, next) {
  const configured = String(process.env.ADMIN_API_SECRET || "").trim();
  const supplied = String(req.headers["x-admin-secret"] || "").trim();
  if (configured && timingSafeEqualString(supplied, configured)) {
    req.auth = {
      uid: "admin-dashboard",
      email: "admin-dashboard@apnaservo.internal",
      email_verified: true
    };
    req.authType = "admin_secret";
    return next();
  }

  return verifyFirebaseToken(req, res, (error) => {
    if (error) return next(error);
    return requireAdmin(req, res, next);
  });
}

module.exports = {
  verifyFirebaseToken,
  verifyAdminSecret,
  requireAdmin,
  attachUser,
  attachPartner
};
