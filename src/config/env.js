const crypto = require("crypto");

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function assertPresent(name, message) {
  if (!env(name)) {
    throw new Error(message || `${name} is required`);
  }
}

function assertPair(left, right) {
  if (env(left) && !env(right)) {
    throw new Error(`${right} is required when ${left} is set`);
  }
  if (env(right) && !env(left)) {
    throw new Error(`${left} is required when ${right} is set`);
  }
}

function getEncryptionKey() {
  const raw = env("ENCRYPTION_KEY");
  if (!raw) {
    return null;
  }

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const base64 = raw.replace(/^base64:/i, "");
  try {
    const decoded = Buffer.from(base64, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch (error) {
    // Fall through to raw string handling.
  }

  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length === 32) {
    return bytes;
  }

  throw new Error("ENCRYPTION_KEY must be 32 raw bytes, 32-byte base64, or 64 hex characters");
}

function generateEncryptionKey() {
  return crypto.randomBytes(32).toString("base64");
}

function validateEnv() {
  assertPresent("MONGODB_URI", "MONGODB_URI is required");
  assertPair("CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET");
  assertPair("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET");
  assertPair("REDIS_REST_URL", "REDIS_REST_TOKEN");

  const hasFirebaseServiceAccount = env("FIREBASE_SERVICE_ACCOUNT_JSON") || env("FIREBASE_SERVICE_ACCOUNT_PATH");
  if (isProduction()) {
    assertPresent("FIREBASE_PROJECT_ID", "FIREBASE_PROJECT_ID is required in production");
    if (!hasFirebaseServiceAccount) {
      throw new Error("A Firebase service account is required in production");
    }
    if (!env("CLIENT_ORIGIN") || env("CLIENT_ORIGIN") === "*") {
      throw new Error("CLIENT_ORIGIN must be an explicit allow-list in production");
    }
    assertPresent("ADMIN_API_SECRET", "ADMIN_API_SECRET is required in production for admin dashboard APIs");
    if (env("ADMIN_API_SECRET").length < 32) {
      throw new Error("ADMIN_API_SECRET must be at least 32 characters in production");
    }
    getEncryptionKey();
  }
}

function allowedCorsOrigins() {
  const configured = env("CLIENT_ORIGIN");
  if (!configured) {
    return [];
  }
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

module.exports = {
  allowedCorsOrigins,
  generateEncryptionKey,
  getEncryptionKey,
  isProduction,
  validateEnv
};
