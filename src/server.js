require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const connectDb = require("./config/db");
const { initFirebase } = require("./config/firebase");
const { initCloudinary } = require("./config/cloudinary");
const userRoutes = require("./routes/userRoutes");
const partnerRoutes = require("./routes/partnerRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const adminRoutes = require("./routes/adminRoutes");
const { initBookingSocket } = require("./sockets/bookingSocket");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
const server = http.createServer(app);

initFirebase();
initCloudinary();
initBookingSocket(server);

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
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
    realtime: "socket.io",
    dataStore: "mongodb"
  });
});

app.use("/api/users", userRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  await connectDb();
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
}

module.exports = {
  app,
  server,
  start
};
