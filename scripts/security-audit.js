const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const checks = [
  {
    name: "booking detail route has explicit authorization guard",
    file: "src/controllers/bookingController.js",
    pass: (text) => text.includes("Not allowed to access this booking") && text.includes("canSeeOpenRequest") && text.includes("canSeeFallbackPending")
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
    name: "admin email allow-list requires verified email",
    file: "src/middleware/authMiddleware.js",
    pass: (text) => text.includes("req.auth.email_verified === true")
  },
  {
    name: "socket partner location updates are rate limited",
    file: "src/sockets/bookingSocket.js",
    pass: (text) => text.includes("allowSocketEvent") && text.includes("partner:location_update")
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
