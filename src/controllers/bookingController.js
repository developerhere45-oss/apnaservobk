const mongoose = require("mongoose");
const { z } = require("zod");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking, BOOKING_STATUSES } = require("../models/Booking");
const { normalizeServiceCategory, serviceLabel } = require("../utils/serviceCategory");
const findNearbyPartners = require("../utils/findNearbyPartners");
const sendNotification = require("../utils/sendNotification");
const {
  emitNewBookingToPartners,
  emitBookingAccepted,
  emitBookingRejected,
  emitBookingStatusUpdate,
  serializeBooking
} = require("../sockets/bookingSocket");

const createBookingSchema = z.object({
  bookingCode: z.string().optional(),
  serviceCategory: z.string().min(1),
  serviceName: z.string().optional(),
  issue: z.string().optional(),
  address: z.string().min(1),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  price: z.number().optional(),
  slot: z.string().optional(),
  userName: z.string().optional(),
  userPhone: z.string().optional()
});

function bookingCode() {
  return `AS${Date.now().toString().slice(-8)}`;
}

async function getOrCreateUser(req, body) {
  return User.findOneAndUpdate(
    { firebaseUid: req.auth.uid },
    {
      $set: {
        name: body.userName || req.auth.name || "ApnaServo Customer",
        phone: body.userPhone || req.auth.phone_number || "",
        email: req.auth.email || "",
        city: body.city || "Guwahati",
        address: body.address || "",
        location: {
          type: "Point",
          coordinates: [Number(body.lng || 91.7362), Number(body.lat || 26.1445)]
        }
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function createBooking(req, res, next) {
  try {
    const body = createBookingSchema.parse(req.body || {});
    const user = await getOrCreateUser(req, body);
    const category = normalizeServiceCategory(body.serviceCategory);
    const lat = Number.isFinite(body.lat) ? body.lat : 26.1445;
    const lng = Number.isFinite(body.lng) ? body.lng : 91.7362;

    const booking = await Booking.create({
      bookingCode: body.bookingCode || bookingCode(),
      userId: user._id,
      serviceCategory: category,
      serviceName: body.serviceName || serviceLabel(category),
      issue: body.issue || `Customer requested ${serviceLabel(category)} inspection`,
      address: body.address,
      city: body.city || "Guwahati",
      location: { type: "Point", coordinates: [lng, lat] },
      price: body.price || 0,
      slot: body.slot || "",
      status: "pending",
      userSnapshot: {
        name: body.userName || user.name,
        phone: body.userPhone || user.phone,
        email: user.email,
        fcmToken: user.fcmToken
      },
      statusTimeline: [{ status: "pending", at: new Date(), by: "user" }]
    });

    const partners = await findNearbyPartners({
      serviceCategory: category,
      city: booking.city,
      lat,
      lng
    });

    if (partners.length) {
      booking.requestedPartners = partners.map((partner) => partner._id);
      booking.status = "sent_to_partner";
      booking.statusTimeline.push({ status: "sent_to_partner", at: new Date(), by: "system" });
      await booking.save();

      emitNewBookingToPartners(booking, partners);
      await sendNotification({
        tokens: partners.map((partner) => partner.fcmToken),
        title: "New Booking Request",
        body: `${booking.serviceName} near ${booking.city}`,
        data: {
          type: "booking:new_request",
          bookingId: booking._id,
          bookingCode: booking.bookingCode,
          serviceCategory: booking.serviceCategory
        }
      });
    }

    return res.status(201).json({
      booking: serializeBooking(booking),
      matchedPartners: partners.length
    });
  } catch (error) {
    return next(error);
  }
}

async function listUserBookings(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) return res.json({ bookings: [] });
    const bookings = await Booking.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50);
    return res.json({ bookings: bookings.map(serializeBooking) });
  } catch (error) {
    return next(error);
  }
}

async function listPartnerBookings(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.json({ bookings: [] });

    const categories = partner.serviceCategory || [];
    const bookings = await Booking.find({
      $or: [
        { partnerId: partner._id },
        {
          status: { $in: ["pending", "sent_to_partner"] },
          serviceCategory: { $in: categories },
          rejectedPartners: { $ne: partner._id }
        }
      ]
    }).sort({ createdAt: -1 }).limit(80);

    return res.json({ bookings: bookings.map(serializeBooking) });
  } catch (error) {
    return next(error);
  }
}

async function acceptBooking(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.status(404).json({ message: "Partner profile not found" });

    const bookingId = req.params.bookingId;
    const query = {
      _id: new mongoose.Types.ObjectId(bookingId),
      status: { $in: ["pending", "sent_to_partner"] },
      partnerId: null,
      rejectedPartners: { $ne: partner._id },
      serviceCategory: { $in: partner.serviceCategory || [] }
    };

    const booking = await Booking.findOneAndUpdate(
      query,
      {
        $set: {
          partnerId: partner._id,
          status: "accepted",
          acceptedAt: new Date(),
          partnerSnapshot: {
            name: partner.name,
            phone: partner.phone,
            rating: partner.rating,
            fcmToken: partner.fcmToken
          }
        },
        $push: { statusTimeline: { status: "accepted", at: new Date(), by: "partner" } }
      },
      { new: true }
    );

    if (!booking) {
      return res.status(409).json({ message: "Booking already accepted or unavailable" });
    }

    emitBookingAccepted(booking);

    const user = await User.findById(booking.userId);
    await sendNotification({
      token: user?.fcmToken,
      title: "Partner Accepted",
      body: `${partner.name} accepted your ${booking.serviceName} booking`,
      data: { type: "booking:accepted", bookingId: booking._id, bookingCode: booking.bookingCode }
    });

    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function rejectBooking(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) return res.status(404).json({ message: "Partner profile not found" });

    const booking = await Booking.findByIdAndUpdate(
      req.params.bookingId,
      {
        $addToSet: { rejectedPartners: partner._id },
        $push: { statusTimeline: { status: "rejected", at: new Date(), by: "partner" } }
      },
      { new: true }
    );

    if (booking) {
      emitBookingRejected(booking, partner._id);
    }

    return res.json({ ok: true, booking: booking ? serializeBooking(booking) : null });
  } catch (error) {
    return next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    const nextStatus = String(req.body?.status || "").toLowerCase();
    if (!BOOKING_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid booking status" });
    }

    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    const query = { _id: req.params.bookingId };
    const finalAmount = Number(req.body?.finalAmount || 0);
    if (partner) {
      query.partnerId = partner._id;
    } else if (user && ["cancelled", "completed"].includes(nextStatus)) {
      query.userId = user._id;
      if (nextStatus === "completed") {
        query.status = "amount_pending";
      }
    } else {
      return res.status(403).json({ message: "Not allowed to update this booking" });
    }

    if (nextStatus === "amount_pending") {
      if (!partner) {
        return res.status(403).json({ message: "Only partner can request final amount" });
      }
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return res.status(400).json({ message: "Final amount required" });
      }
    }

    const update = {
      $set: { status: nextStatus },
      $push: { statusTimeline: { status: nextStatus, at: new Date(), by: partner ? "partner" : "user" } }
    };
    if (nextStatus === "amount_pending") {
      update.$set.finalAmount = finalAmount;
      update.$set.paymentStatus = "pending";
      update.$set.amountRequestedAt = new Date();
    }
    if (nextStatus === "completed") {
      update.$set.completedAt = new Date();
      update.$set.paymentStatus = "paid";
      if (finalAmount > 0) {
        update.$set.finalAmount = finalAmount;
      }
    }

    const booking = await Booking.findOneAndUpdate(query, update, { new: true });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (nextStatus === "completed" && booking.partnerId) {
      await Partner.findByIdAndUpdate(booking.partnerId, {
        $inc: { totalJobs: 1, earnings: Number(booking.finalAmount || finalAmount || booking.price || 0) }
      });
    }

    emitBookingStatusUpdate(booking);

    const userForNotification = await User.findById(booking.userId);
    if (["on_the_way", "amount_pending", "completed"].includes(nextStatus)) {
      await sendNotification({
        token: userForNotification?.fcmToken,
        title: nextStatus === "completed"
          ? "Booking Completed"
          : nextStatus === "amount_pending"
            ? "Confirm Final Amount"
            : "Partner On The Way",
        body: nextStatus === "amount_pending"
          ? `Partner entered Rs ${booking.finalAmount}. Please confirm.`
          : `${booking.serviceName} is ${nextStatus.replace(/_/g, " ")}`,
        data: { type: "booking:status_update", status: nextStatus, bookingId: booking._id }
      });
    }

    if (!partner && nextStatus === "completed" && booking.partnerId) {
      const partnerForNotification = await Partner.findById(booking.partnerId);
      await sendNotification({
        token: partnerForNotification?.fcmToken,
        title: "Payment Confirmed",
        body: `Customer confirmed Rs ${booking.finalAmount || booking.price || 0}`,
        data: { type: "booking:status_update", status: "completed", bookingId: booking._id }
      });
    }

    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

async function getBooking(req, res, next) {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    return res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createBooking,
  listUserBookings,
  listPartnerBookings,
  acceptBooking,
  rejectBooking,
  updateStatus,
  getBooking
};
