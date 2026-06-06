const { admin } = require("../config/firebase");
const User = require("../models/User");
const Partner = require("../models/Partner");
const crypto = require("crypto");

let io;

function getAdminSecret() {
  return process.env.ADMIN_API_SECRET || (process.env.NODE_ENV !== "production" ? "apnaservo-admin-dev-secret" : "");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyAdminRealtimeToken(token) {
  const secret = getAdminSecret();
  if (!secret || !token) return false;

  if (safeEqual(token, secret)) {
    return process.env.NODE_ENV !== "production";
  }

  const [expiresAt, signature] = String(token).split(".");
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry < Date.now() || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
  return safeEqual(signature, expected);
}

function serializeBooking(booking) {
  const doc = typeof booking.toObject === "function" ? booking.toObject() : booking;
  const location = doc.location || { coordinates: [0, 0] };
  return {
    _id: String(doc._id),
    bookingId: String(doc._id),
    bookingCode: doc.bookingCode,
    userId: doc.userId ? String(doc.userId) : "",
    partnerId: doc.partnerId ? String(doc.partnerId) : "",
    serviceCategory: doc.serviceCategory,
    serviceName: doc.serviceName,
    issue: doc.issue,
    address: doc.address,
    city: doc.city,
    lat: location.coordinates ? location.coordinates[1] : 0,
    lng: location.coordinates ? location.coordinates[0] : 0,
    status: doc.status,
    price: doc.price,
    finalAmount: doc.finalAmount || 0,
    paymentStatus: doc.paymentStatus,
    slot: doc.slot,
    userName: doc.userSnapshot?.name || "",
    userPhone: doc.userSnapshot?.phone || "",
    partnerName: doc.partnerSnapshot?.name || "",
    partnerPhone: doc.partnerSnapshot?.phone || "",
    createdAt: doc.createdAt,
    acceptedAt: doc.acceptedAt,
    completedAt: doc.completedAt
  };
}

async function identifySocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace("Bearer ", "");
    const role = socket.handshake.auth?.role || socket.handshake.query?.role || "";

    if (role === "admin") {
      const adminToken = socket.handshake.auth?.adminToken || socket.handshake.query?.adminToken || "";
      if (!verifyAdminRealtimeToken(adminToken)) {
        return next(new Error("Admin realtime token invalid"));
      }
      socket.role = "admin";
      socket.join("admin");
      return next();
    }

    if (!token) {
      return next(new Error("Firebase token missing"));
    }

    const decoded = await admin.auth().verifyIdToken(token);
    socket.auth = decoded;
    socket.role = role;

    if (role === "partner") {
      const partner = await Partner.findOne({ firebaseUid: decoded.uid });
      if (partner) {
        socket.partner = partner;
        socket.join(`partner:${partner._id}`);
        socket.join(`city:${partner.city}`);
        for (const category of partner.serviceCategory || []) {
          socket.join(`service:${category}`);
        }
      }
    } else {
      const user = await User.findOne({ firebaseUid: decoded.uid });
      if (user) {
        socket.user = user;
        socket.join(`user:${user._id}`);
      }
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function initBookingSocket(httpServer) {
  io = require("socket.io")(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "*",
      methods: ["GET", "POST", "PATCH"]
    },
    pingTimeout: 30000
  });

  io.use(identifySocket);

  io.on("connection", (socket) => {
    if (socket.role === "admin") {
      socket.emit("admin:connected", { ok: true, at: new Date().toISOString() });
    }

    socket.on("partner:online", async (payload = {}) => {
      if (!socket.partner) return;
      socket.partner.isOnline = true;
      if (payload.lat && payload.lng) {
        socket.partner.location = { type: "Point", coordinates: [Number(payload.lng), Number(payload.lat)] };
      }
      await socket.partner.save();
      socket.join(`partner:${socket.partner._id}`);
      socket.emit("partner:online", { ok: true });
      io.to("admin").emit("partner:online", {
        partnerId: String(socket.partner._id),
        name: socket.partner.name,
        serviceCategory: socket.partner.serviceCategory,
        city: socket.partner.city,
        isOnline: true
      });
    });

    socket.on("partner:offline", async () => {
      if (!socket.partner) return;
      socket.partner.isOnline = false;
      await socket.partner.save();
      socket.emit("partner:offline", { ok: true });
      io.to("admin").emit("partner:offline", {
        partnerId: String(socket.partner._id),
        name: socket.partner.name,
        isOnline: false
      });
    });

    socket.on("partner:location_update", async (payload = {}) => {
      if (!socket.partner) return;
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        socket.partner.location = { type: "Point", coordinates: [lng, lat] };
        await socket.partner.save();
        io.to("admin").emit("partner:location_update", {
          partnerId: String(socket.partner._id),
          name: socket.partner.name,
          lat,
          lng
        });
      }
    });
  });

  return io;
}

function emitNewBookingToPartners(booking, partners) {
  if (!io) return;
  const payload = serializeBooking(booking);
  for (const partner of partners) {
    io.to(`partner:${partner._id}`).emit("booking:new_request", payload);
  }
  io.to(`service:${booking.serviceCategory}`).emit("booking:new_request", payload);
  io.to(`city:${booking.city}`).emit("booking:new_request", payload);
  io.to("admin").emit("booking:new_request", payload);
  io.to("admin").emit("admin:activity", {
    type: "booking:new_request",
    title: "New booking created",
    note: booking.bookingCode || String(booking._id),
    at: new Date().toISOString(),
    booking: payload
  });
}

function emitBookingAccepted(booking) {
  if (!io) return;
  const payload = serializeBooking(booking);
  io.to(`user:${booking.userId}`).emit("booking:accepted", payload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:accepted", payload);
  }
  for (const partnerId of booking.requestedPartners || []) {
    io.to(`partner:${partnerId}`).emit("booking:status_update", payload);
  }
  io.to("admin").emit("booking:accepted", payload);
  io.to("admin").emit("booking:status_update", payload);
}

function emitBookingRejected(booking, partnerId) {
  if (!io) return;
  io.to(`partner:${partnerId}`).emit("booking:rejected", serializeBooking(booking));
  io.to("admin").emit("booking:rejected", serializeBooking(booking));
}

function emitBookingStatusUpdate(booking) {
  if (!io) return;
  const payload = serializeBooking(booking);
  io.to(`user:${booking.userId}`).emit("booking:status_update", payload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:status_update", payload);
  }
  io.to("admin").emit("booking:status_update", payload);
}

function getIO() {
  return io;
}

module.exports = {
  initBookingSocket,
  emitNewBookingToPartners,
  emitBookingAccepted,
  emitBookingRejected,
  emitBookingStatusUpdate,
  serializeBooking,
  getIO
};
