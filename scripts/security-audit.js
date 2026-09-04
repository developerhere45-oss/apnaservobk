const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const checks = [
  {
    name: "booking detail route has explicit authorization guard",
    file: "src/controllers/bookingController.js",
    pass: (text) => text.includes("Not allowed to access this booking")
      && text.includes("canSeeOpenRequest")
      && text.includes("isRequestedPartner")
      && !text.includes("canSeeFallbackPending")
  },
  {
    name: "socket booking requests are not broadcast to service/city rooms",
    file: "src/sockets/bookingSocket.js",
    pass: (text) => !text.includes('io.to(`service:${booking.serviceCategory}`).emit("booking:new_request"') && !text.includes('io.to(`city:${booking.city}`).emit("booking:new_request"')
  },
  {
    name: "file uploads validate content magic bytes",
    file: "src/routes/bookingRoutes.js",
    pass: (text) => text.includes("validateUploadedImage")
  },
  {
    name: "partner document uploads validate content magic bytes",
    file: "src/routes/partnerRoutes.js",
    pass: (text) => text.includes("validateUploadedImage")
  },
  {
    name: "rate limits key by Firebase uid with IPv6-safe IP fallback",
    file: "src/middleware/securityRateLimits.js",
    pass: (text) => text.includes("req.auth?.uid") && text.includes("ipKeyGenerator")
  },
  {
    name: "production auth errors do not expose token verification details",
    file: "src/middleware/authMiddleware.js",
    pass: (text) => text.includes('process.env.NODE_ENV !== "production"') && text.includes("payload.detail")
  },
  {
    name: "development device authentication is disabled in production",
    file: "src/middleware/authMiddleware.js",
    pass: (text) => text.includes('process.env.NODE_ENV === "production"')
      && text.includes('process.env.DISABLE_DEVICE_AUTH_FALLBACK !== "false"')
  },
  {
    name: "OTP send and verification routes have dedicated rate limits",
    file: "src/routes/otpRoutes.js",
    pass: (text) => text.includes("loginLimiter") && text.includes("verificationLimiter")
  },
  {
    name: "admin email allow-list requires verified email",
    file: "src/middleware/authMiddleware.js",
    pass: (text) => text.includes("req.auth.email_verified === true")
  },
  {
    name: "customer account deletion is authenticated and deletes Firebase identity",
    file: "src/controllers/userController.js",
    pass: (text) => text.includes("async function deleteAccount")
      && text.includes("req.auth.uid")
      && text.includes("admin.auth().deleteUser")
      && text.includes("User.deleteOne")
  },
  {
    name: "socket partner location updates are rate limited",
    file: "src/sockets/bookingSocket.js",
    pass: (text) => text.includes("allowSocketEvent") && text.includes("partner:location_update")
  },
  {
    name: "notification pagination rejects non-integer and oversized input",
    file: "src/controllers/notificationController.js",
    pass: (text) => text.includes("Number.isInteger(requestedLimit)")
      && text.includes("requestedLimit > 100")
      && text.includes("requestedPage > 10000")
  },
  {
    name: "notification identifiers are validated before database lookup",
    file: "src/controllers/notificationController.js",
    pass: (text) => text.includes("mongoose.isValidObjectId(req.params.notificationId)")
  },
  {
    name: "public media identifiers are validated before database lookup",
    file: "src/controllers/appControlController.js",
    pass: (text) => text.includes("mongoose.isValidObjectId(req.params.assetId)")
  },
  {
    name: "production access logs redact signed asset credentials",
    file: "src/server.js",
    pass: (text) => text.includes("safe-url") && text.includes("[REDACTED]")
  },
  {
    name: "server error logs redact query-string credentials",
    file: "src/middleware/errorHandler.js",
    pass: (text) => text.includes("redactedPath(req)") && text.includes("[REDACTED]")
  },
  {
    name: "production deployment rejects expired Firebase tokens",
    file: "render.yaml",
    pass: (text) => /FIREBASE_EXPIRED_TOKEN_GRACE_SECONDS\s*\r?\n\s*value:\s*["']0["']/.test(text)
  },
  {
    name: "expired-token emergency grace is disabled by default and tightly bounded",
    file: "src/utils/firebaseTokenVerifier.js",
    pass: (text) => text.includes("DEFAULT_GRACE_SECONDS = 0")
      && text.includes("MAX_GRACE_SECONDS = 5 * 60")
  }
];

const results = checks.map((check) => {
  const absolute = path.join(root, check.file);
  const text = fs.readFileSync(absolute, "utf8");
  return {
    name: check.name,
    file: check.file,
    ok: Boolean(check.pass(text))
  };
});

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.file})`);
}

const failures = results.filter((result) => !result.ok);
if (failures.length) {
  console.error(`\nSecurity audit failed: ${failures.length} check(s).`);
  process.exit(1);
}

console.log(`\nSecurity audit passed: ${results.length} checks.`);
