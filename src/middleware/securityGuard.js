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

  if (!fields.length) {
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
