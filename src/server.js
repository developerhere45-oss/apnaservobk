require("dotenv").config();

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { allowedCorsOrigins, validateEnv } = require("./config/env");
const connectDb = require("./config/db");
const { initFirebase } = require("./config/firebase");
const { initCloudinary } = require("./config/cloudinary");
const userRoutes = require("./routes/userRoutes");
const partnerRoutes = require("./routes/partnerRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const adminRoutes = require("./routes/adminRoutes");
const employeeRoutes = require("./routes/employeeRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const { initBookingSocket } = require("./sockets/bookingSocket");
const { startNotificationScheduler } = require("./utils/notificationScheduler");
const cache = require("./config/cache");
const { cdnFriendlyHeaders } = require("./middleware/cdnHeaders");
const { requireHttpsInProduction } = require("./middleware/httpsOnly");
const { rejectPlainSensitiveFields } = require("./middleware/securityGuard");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
const server = http.createServer(app);

validateEnv();
initFirebase();
initCloudinary();
initBookingSocket(server);

app.disable("x-powered-by");
app.set("trust proxy", 1);
server.keepAliveTimeout = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 30000);
app.use(requireHttpsInProduction);
app.use(helmet({
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 15552000, includeSubDomains: true, preload: true }
    : false
}));
app.use(cdnFriendlyHeaders);
app.use(cors({
  origin(origin, callback) {
    const allowed = allowedCorsOrigins();
    if (!origin) {
      return callback(null, true);
    }
    if (allowed.includes("*") && process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }
    return callback(null, allowed.includes(origin));
  },
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rejectPlainSensitiveFields);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "apnaservo-backend",
    release: String(process.env.RENDER_GIT_COMMIT || process.env.APP_RELEASE || "local").slice(0, 7),
    realtime: "socket.io",
    dataStore: "mongodb",
    capabilities: {
      partnerReapproval: true,
      fastBookingDispatch: true,
      partnerUploadAssets: true,
      partnerPaymentVerification: true,
      broadPartnerDispatch: true,
      deviceAuthFallback: process.env.DISABLE_DEVICE_AUTH_FALLBACK !== "true"
    }
  });
});

app.get("/ready", (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    ok: mongoReady,
    mongo: mongoReady ? "connected" : "not_ready",
    cache: cache.status()
  });
});

app.use("/api/users", userRoutes);
app.use("/api/partner", partnerRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/employee", employeeRoutes);

app.use(notFound);
app.use(errorHandler);

function keepAliveUrl() {
  return String(
    process.env.KEEP_ALIVE_URL
    || process.env.PUBLIC_BACKEND_URL
    || process.env.RENDER_EXTERNAL_URL
    || ""
  ).replace(/\/$/, "");
}

function startKeepAlive() {
  if (String(process.env.DISABLE_BACKEND_KEEP_ALIVE || "").toLowerCase() === "true") return;
  const baseUrl = keepAliveUrl();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return;
  const intervalMs = Math.max(Number(process.env.BACKEND_KEEP_ALIVE_INTERVAL_MS || 8 * 60 * 1000), 60 * 1000);
  const ping = async () => {
    try {
      await fetch(`${baseUrl}/health`, { method: "GET" });
    } catch (error) {
      console.warn("Backend keep-alive ping failed:", error.message);
    }
  };
  setTimeout(ping, 30 * 1000).unref();
  setInterval(ping, intervalMs).unref();
}

async function start() {
  await connectDb();
  startNotificationScheduler();
  startKeepAlive();
  const port = Number(process.env.PORT || 5000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`ApnaServo backend running on http://0.0.0.0:${port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Failed to start ApnaServo backend:", error);
    process.exit(1);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, closing ApnaServo backend`);
    server.close(async () => {
      await mongoose.connection.close(false);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = {
  app,
  server,
  start
};
