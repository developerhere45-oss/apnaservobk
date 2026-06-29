const crypto = require("crypto");

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (configured) return configured;
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  if (!host) return "";
  return `${host.includes("onrender.com") ? "https" : proto}://${host}`;
}

function assetSecret() {
  return String(
    process.env.ADMIN_API_SECRET
    || process.env.ADMIN_BACKEND_SECRET
    || process.env.ENCRYPTION_KEY
    || "apnaservo-local-partner-asset-secret"
  );
}

function signPartnerAsset(assetId) {
  return crypto
    .createHmac("sha256", assetSecret())
    .update(`partner-upload-asset:v1:${String(assetId)}`)
    .digest("hex");
}

function verifyPartnerAssetToken(assetId, token) {
  const expected = signPartnerAsset(assetId);
  const supplied = String(token || "");
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function partnerAssetUrl(req, assetId) {
  const baseUrl = publicBaseUrl(req);
  if (!baseUrl || !assetId) return "";
  return `${baseUrl}/api/admin/partners/assets/${assetId}?token=${signPartnerAsset(assetId)}`;
}

module.exports = {
  partnerAssetUrl,
  publicBaseUrl,
  verifyPartnerAssetToken
};
