const { admin } = require("../config/firebase");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Partner = require("../models/Partner");
const Admin = require("../models/Admin");
const Employee = require("../models/Employee");
const ChatAssignment = require("../models/ChatAssignment");

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
  if (process.env.DISABLE_DEVICE_AUTH_FALLBACK === "true") {
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

function authJwtSecret() {
  return String(
    process.env.JWT_SECRET
    || process.env.ADMIN_JWT_SECRET
    || process.env.ADMIN_API_SECRET
    || "dev-only-apnaservo-role-secret-change-me"
  );
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function signRoleToken(payload) {
  const secret = authJwtSecret();
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32 || secret.startsWith("dev-only"))) {
    throw new Error("JWT_SECRET or ADMIN_JWT_SECRET must be a 32+ character secret in production");
  }
  return jwt.sign(payload, secret, { expiresIn: "8h" });
}

function verifyRoleToken(req) {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, authJwtSecret());
  } catch {
    return null;
  }
}

async function authAdminJwt(req, res, next) {
  try {
    const payload = verifyRoleToken(req);
    if (!payload || payload.type !== "admin" || !["super_admin", "admin"].includes(payload.role)) {
      return res.status(401).json({ message: "Admin token required" });
    }
    const adminProfile = await Admin.findById(payload.id);
    if (!adminProfile || adminProfile.status !== "active") {
      return res.status(403).json({ message: "Admin account inactive" });
    }
    req.adminProfile = adminProfile;
    req.auth = {
      uid: String(adminProfile._id),
      email: adminProfile.email,
      email_verified: true,
      role: adminProfile.role,
      type: "admin"
    };
    req.authType = "admin_jwt";
    return next();
  } catch (error) {
    return next(error);
  }
}

async function authEmployee(req, res, next) {
  try {
    const payload = verifyRoleToken(req);
    if (!payload || payload.type !== "employee" || payload.role !== "employee") {
      return res.status(401).json({ message: "Employee token required" });
    }
    const employee = await Employee.findById(payload.id);
    if (!employee || employee.status !== "active") {
      return res.status(403).json({ message: "Employee account inactive" });
    }
    req.employeeProfile = employee;
    req.auth = {
      uid: String(employee._id),
      email: employee.email,
      email_verified: true,
      role: "employee",
      type: "employee",
      permissions: employee.permissions || {}
    };
    req.authType = "employee_jwt";
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.adminProfile?.role || req.employeeProfile?.role || req.auth?.role;
    if (!roles.includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    return next();
  };
}

function requirePermission(permissionName) {
  return (req, res, next) => {
    const permissions = req.employeeProfile?.permissions || req.auth?.permissions || {};
    if (permissions[permissionName] !== true) {
      return res.status(403).json({ message: "Permission denied" });
    }
    return next();
  };
}

async function checkChatAssignment(req, res, next) {
  try {
    const employeeId = req.employeeProfile?._id;
    const chatId = req.params.chatId || req.params.assignmentId;
    const objectFilters = [];
    if (require("mongoose").Types.ObjectId.isValid(chatId)) {
      objectFilters.push({ _id: chatId }, { chatId }, { bookingId: chatId });
    }
    if (!objectFilters.length) {
      return res.status(403).json({ message: "Access denied for this chat" });
    }
    const assignment = await ChatAssignment.findOne({
      $or: objectFilters,
      assignedTo: employeeId
    });
    if (!assignment) {
      return res.status(403).json({ message: "Access denied for this chat" });
    }
    req.chatAssignment = assignment;
    return next();
  } catch (error) {
    return next(error);
  }
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

  const rolePayload = verifyRoleToken(req);
  if (rolePayload?.type === "admin" && ["super_admin", "admin"].includes(rolePayload.role)) {
    return authAdminJwt(req, res, next);
  }

  return verifyFirebaseToken(req, res, (error) => {
    if (error) return next(error);
    return requireAdmin(req, res, next);
  });
}

module.exports = {
  authAdminJwt,
  authEmployee,
  checkChatAssignment,
  verifyFirebaseToken,
  verifyAdminSecret,
  requireAdmin,
  requirePermission,
  requireRole,
  signRoleToken,
  attachUser,
  attachPartner
};
