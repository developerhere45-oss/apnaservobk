function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isAllowedSensitiveKey(normalizedKey) {
  return normalizedKey === "aadhaarlast4" || normalizedKey === "aadharlast4";
}

function isBlockedSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized || isAllowedSensitiveKey(normalized)) {
    return false;
  }

  if (normalized.includes("password")) {
    return true;
  }

  if (normalized.includes("aadhaar") || normalized.includes("aadhar")) {
    return true;
  }

  if (normalized === "otp" || normalized === "otpsms" || normalized === "onetimepassword") {
    return true;
  }

  if (["cvv", "cvc", "cardcvv", "cardcvc", "securitycode"].includes(normalized)) {
    return true;
  }

  if (normalized.includes("card") && /(number|expiry|exp|cvv|cvc|pin|holder)/.test(normalized)) {
    return true;
  }

  if (normalized.includes("upi") && normalized.includes("pin")) {
    return true;
  }

  return false;
}

function isPasswordPath(path) {
  return normalizeKey(path).includes("password");
}

function isAllowedPasswordEndpoint(req) {
  const method = String(req.method || "").toUpperCase();
  const path = String(req.originalUrl || req.path || "").split("?")[0].replace(/\/+$/, "");

  if (method === "POST" && ["/api/admin/login", "/api/employee/login"].includes(path)) {
    return true;
  }

  if (method === "PATCH" && ["/api/admin/change-password", "/api/employee/change-password"].includes(path)) {
    return true;
  }

  if (method === "POST" && path === "/api/admin/employees") {
    return true;
  }

  if (method === "PATCH" && /^\/api\/admin\/employees\/[^/]+\/reset-password$/.test(path)) {
    return true;
  }

  return false;
}

function findSensitivePaths(value, prefix = "", found = []) {
  if (!value || typeof value !== "object") {
    return found;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isBlockedSensitiveKey(key)) {
      found.push(path);
      continue;
    }
    findSensitivePaths(child, path, found);
  }
  return found;
}

function rejectPlainSensitiveFields(req, res, next) {
  const bodyFields = findSensitivePaths(req.body);
  const queryFields = findSensitivePaths(req.query);
  const fields = [...bodyFields, ...queryFields];
  const passwordOnly = fields.length > 0 && fields.every(isPasswordPath);

  if (!fields.length) {
    return next();
  }

  if (passwordOnly && isAllowedPasswordEndpoint(req)) {
    return next();
  }

  return res.status(400).json({
    message: "Sensitive plaintext fields are not allowed",
    fields
  });
}

module.exports = {
  rejectPlainSensitiveFields
};
