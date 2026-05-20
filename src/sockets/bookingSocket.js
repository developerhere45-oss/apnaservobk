const { admin } = require("../config/firebase");
const User = require("../models/User");
const Partner = require("../models/Partner");

let io;

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
    socket.on("partner:online", async (payload = {}) => {
      if (!socket.partner) return;
      socket.partner.isOnline = true;
      if (payload.lat && payload.lng) {
        socket.partner.location = { type: "Point", coordinates: [Number(payload.lng), Number(payload.lat)] };
      }
      await socket.partner.save();
      socket.join(`partner:${socket.partner._id}`);
      socket.emit("partner:online", { ok: true });
    });

    socket.on("partner:offline", async () => {
      if (!socket.partner) return;
      socket.partner.isOnline = false;
      await socket.partner.save();
      socket.emit("partner:offline", { ok: true });
    });

    socket.on("partner:location_update", async (payload = {}) => {
      if (!socket.partner) return;
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        socket.partner.location = { type: "Point", coordinates: [lng, lat] };
        await socket.partner.save();
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
}

function emitBookingRejected(booking, partnerId) {
  if (!io) return;
  io.to(`partner:${partnerId}`).emit("booking:rejected", serializeBooking(booking));
}

function emitBookingStatusUpdate(booking) {
  if (!io) return;
  const payload = serializeBooking(booking);
  io.to(`user:${booking.userId}`).emit("booking:status_update", payload);
  if (booking.partnerId) {
    io.to(`partner:${booking.partnerId}`).emit("booking:status_update", payload);
  }
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
