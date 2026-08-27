const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { admin } = require("../src/config/firebase");

async function run() {
  process.env.NODE_ENV = "production";
  process.env.FIREBASE_PROJECT_ID = "apnaservo-compat-audit";
  process.env.FIREBASE_EXPIRED_TOKEN_GRACE_SECONDS = "86400";

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = publicKey.export({ type: "spki", format: "pem" });
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "partner-compatibility-uid",
    aud: process.env.FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${process.env.FIREBASE_PROJECT_ID}`,
    auth_time: now - 7200,
    iat: now - 7200,
    exp: now - 3600,
    email_verified: true
  };
  const token = jwt.sign(payload, privateKey, { algorithm: "RS256", keyid: "audit-key" });

  admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  const auth = admin.auth();
  auth.verifyIdToken = async () => {
    const error = new Error("expired");
    error.code = "auth/id-token-expired";
    throw error;
  };
  auth.getUser = async () => ({ disabled: false, tokensValidAfterTime: null });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ "audit-key": certificate }),
    headers: { get: () => "public, max-age=3600" }
  });

  const { verifyFirebaseIdToken } = require("../src/utils/firebaseTokenVerifier");
  const decoded = await verifyFirebaseIdToken(token, true);
  assert.equal(decoded.uid, payload.sub);
  assert.equal(decoded.expired_token_grace, true);

  const forgedKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const forged = jwt.sign(payload, forgedKey, { algorithm: "RS256", keyid: "audit-key" });
  await assert.rejects(() => verifyFirebaseIdToken(forged, true));

  const tooOld = jwt.sign({ ...payload, exp: now - 90000 }, privateKey, { algorithm: "RS256", keyid: "audit-key" });
  await assert.rejects(() => verifyFirebaseIdToken(tooOld, true));

  console.log("PASS expired Firebase compatibility verifies signature, project and bounded grace");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
