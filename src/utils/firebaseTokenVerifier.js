const jwt = require("jsonwebtoken");
const { admin } = require("../config/firebase");

const FIREBASE_CERT_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const DEFAULT_GRACE_SECONDS = 0;
// Emergency-only rollout escape hatch. Current Android and iOS clients refresh
// Firebase credentials, so production should keep this at zero.
const MAX_GRACE_SECONDS = 5 * 60;

let certificateCache = { certificates: null, expiresAt: 0 };

function graceSeconds() {
  const configured = Number(process.env.FIREBASE_EXPIRED_TOKEN_GRACE_SECONDS || DEFAULT_GRACE_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.min(Math.floor(configured), MAX_GRACE_SECONDS);
}

function firebaseProjectId() {
  return String(process.env.FIREBASE_PROJECT_ID || admin.app().options.projectId || "").trim();
}

function cacheMaxAge(header) {
  const match = String(header || "").match(/(?:^|,)\s*max-age=(\d+)/i);
  return match ? Math.max(Number(match[1]), 60) * 1000 : 60 * 60 * 1000;
}

async function firebaseCertificates() {
  if (certificateCache.certificates && certificateCache.expiresAt > Date.now() + 30_000) {
    return certificateCache.certificates;
  }
  const response = await fetch(FIREBASE_CERT_URL, { method: "GET" });
  if (!response.ok) throw new Error(`Firebase signing certificates unavailable (${response.status})`);
  const certificates = await response.json();
  certificateCache = {
    certificates,
    expiresAt: Date.now() + cacheMaxAge(response.headers.get("cache-control"))
  };
  return certificates;
}

async function verifyExpiredTokenWithGrace(token) {
  const allowedGrace = graceSeconds();
  if (!allowedGrace) throw new Error("Expired-token compatibility is disabled");
  const projectId = firebaseProjectId();
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");

  const unverified = jwt.decode(token, { complete: true });
  const keyId = String(unverified?.header?.kid || "");
  if (!keyId || unverified?.header?.alg !== "RS256") throw new Error("Invalid Firebase token header");

  const certificates = await firebaseCertificates();
  const certificate = certificates[keyId];
  if (!certificate) throw new Error("Firebase signing key not found");

  const payload = jwt.verify(token, certificate, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    ignoreExpiration: true
  });
  const uid = String(payload.sub || "");
  const expiredBy = Math.floor(Date.now() / 1000) - Number(payload.exp || 0);
  if (!uid || uid.length > 128 || !Number.isFinite(expiredBy) || expiredBy < 0 || expiredBy > allowedGrace) {
    throw new Error("Firebase token is outside the compatibility grace window");
  }

  // Only expiry is relaxed. Signature, project, revocation and disabled-account
  // checks remain mandatory for production partner and customer sessions.
  const user = await admin.auth().getUser(uid);
  if (user.disabled) throw new Error("Firebase user is disabled");
  const validAfter = user.tokensValidAfterTime
    ? Math.floor(new Date(user.tokensValidAfterTime).getTime() / 1000)
    : 0;
  if (validAfter && Number(payload.auth_time || 0) < validAfter) {
    throw new Error("Firebase token has been revoked");
  }

  return { ...payload, uid, expired_token_grace: true };
}

async function verifyFirebaseIdToken(token, checkRevoked = false) {
  try {
    return await admin.auth().verifyIdToken(token, checkRevoked);
  } catch (error) {
    if (process.env.NODE_ENV !== "production" || error?.code !== "auth/id-token-expired") throw error;
    const decoded = await verifyExpiredTokenWithGrace(token);
    console.warn("firebase_expired_token_grace", {
      uidSuffix: String(decoded.uid).slice(-6),
      expiredSeconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(decoded.exp || 0))
    });
    return decoded;
  }
}

module.exports = { verifyFirebaseIdToken };
