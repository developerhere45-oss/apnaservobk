const crypto = require("crypto");

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function normalizeDeviceToken({ token, platform, deviceId, appType }) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken || cleanToken.length > 4096) {
    return null;
  }
  return {
    token: cleanToken,
    tokenHash: tokenHash(cleanToken),
    platform: ["android", "ios", "web"].includes(String(platform || "").toLowerCase()) ? String(platform).toLowerCase() : "android",
    deviceId: String(deviceId || tokenHash(cleanToken).slice(0, 24)).trim().slice(0, 160),
    appType,
    isActive: true,
    lastUpdatedAt: new Date()
  };
}

function activeDeviceTokens(owner, appType) {
  const tokens = [];
  const seen = new Set();
  for (const device of owner?.deviceTokens || []) {
    if (!device?.isActive || !device.token) continue;
    const token = String(device.token).trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push({
      token,
      tokenHash: device.tokenHash || tokenHash(token),
      platform: device.platform || "android",
      deviceId: device.deviceId || "",
      appType
    });
  }
  if (owner?.fcmToken) {
    const token = String(owner.fcmToken).trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      tokens.push({
        token,
        tokenHash: tokenHash(token),
        platform: "android",
        deviceId: "legacy",
        appType
      });
    }
  }
  return tokens;
}

function upsertDeviceToken(owner, deviceToken) {
  const now = new Date();
  const devices = Array.isArray(owner.deviceTokens) ? owner.deviceTokens : [];
  const existing = devices.find((device) =>
    String(device.tokenHash || "") === deviceToken.tokenHash
    || (device.deviceId && deviceToken.deviceId && String(device.deviceId) === String(deviceToken.deviceId))
  );
  if (existing) {
    existing.token = deviceToken.token;
    existing.tokenHash = deviceToken.tokenHash;
    existing.platform = deviceToken.platform;
    existing.deviceId = deviceToken.deviceId;
    existing.appType = deviceToken.appType;
    existing.isActive = true;
    existing.lastUpdatedAt = now;
  } else {
    devices.push({
      ...deviceToken,
      createdAt: now,
      lastUpdatedAt: now
    });
  }
  owner.deviceTokens = devices.slice(-12);
  owner.fcmToken = deviceToken.token;
}

function removeDeviceToken(owner, tokenOrDeviceId) {
  const value = String(tokenOrDeviceId || "").trim();
  if (!value) return false;
  const hash = value.length > 80 ? tokenHash(value) : "";
  let removed = false;
  for (const device of owner.deviceTokens || []) {
    if (
      String(device.deviceId || "") === value
      || String(device.tokenHash || "") === hash
      || String(device.token || "") === value
    ) {
      device.isActive = false;
      device.lastUpdatedAt = new Date();
      removed = true;
    }
  }
  if (owner.fcmToken && (String(owner.fcmToken) === value || tokenHash(owner.fcmToken) === hash)) {
    owner.fcmToken = "";
    removed = true;
  }
  return removed;
}

module.exports = {
  activeDeviceTokens,
  normalizeDeviceToken,
  removeDeviceToken,
  tokenHash,
  upsertDeviceToken
};
