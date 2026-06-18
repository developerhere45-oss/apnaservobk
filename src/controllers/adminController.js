const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");
const Service = require("../models/Service");
const Review = require("../models/Review");
const ReviewDispute = require("../models/ReviewDispute");
const InAppNotification = require("../models/InAppNotification");
const cache = require("../config/cache");
const { recomputePartnerRating } = require("../utils/ratingAggregation");

function iso(value) {
  return value ? new Date(value).toISOString() : "";
}

function money(value) {
  return Number(value || 0);
}

function id(value) {
  return value ? String(value) : "";
}

async function dashboard(req, res, next) {
  try {
    const cached = await cache.getJson("admin:dashboard:v1");
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    const [users, partners, bookings, pendingBookings] = await Promise.all([
      User.countDocuments(),
      Partner.countDocuments(),
      Booking.countDocuments(),
      Booking.countDocuments({ status: { $in: ["pending", "sent_to_partner"] } })
    ]);

    const payload = {
      users,
      partners,
      bookings,
      pendingBookings
    };
    await cache.setJson("admin:dashboard:v1", payload, 10);
    res.setHeader("X-Cache", "MISS");
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
}

async function listResourceRows(req, res, next) {
  try {
    const resource = String(req.params.resource || "").trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit || 100), 250);
    let rows = [];

    if (resource === "users") {
      const users = await User.find().sort({ createdAt: -1 }).limit(limit);
      rows = users.map((user) => ({
        id: id(user._id),
        name: user.name,
        phone: user.phone,
        email: user.email,
        city: user.city,
        status: user.accountStatus || "active",
        risk: user.bookingRiskStatus,
        createdAt: iso(user.createdAt)
      }));
    } else if (resource === "partners") {
      const partners = await Partner.find().sort({ createdAt: -1 }).limit(limit);
      rows = partners.map((partner) => ({
        id: id(partner._id),
        code: partner.partnerCode || "",
        name: partner.name,
        phone: partner.phone,
        services: (partner.serviceCategory || []).join(", "),
        online: Boolean(partner.isOnline),
        kyc: partner.kycStatus,
        trust: partner.trustStatus,
        status: partner.accountStatus || "active",
        rating: Number(partner.rating || 0)
      }));
    } else if (resource === "bookings" || resource === "quotes") {
      const bookings = await Booking.find().sort({ createdAt: -1 }).limit(limit);
      rows = bookings.map((booking) => ({
        id: id(booking._id),
        bookingCode: booking.bookingCode,
        service: booking.serviceName || booking.serviceCategory,
        customer: booking.userSnapshot?.name || "",
        partner: booking.partnerSnapshot?.name || "",
        status: booking.status,
        quoteStatus: booking.quoteStatus || "none",
        amount: money(booking.finalAmount || booking.quoteAmount || booking.price),
        city: booking.city,
        createdAt: iso(booking.createdAt)
      }));
    } else if (resource === "services") {
      const services = await Service.find().sort({ createdAt: -1 }).limit(limit);
      rows = services.map((service) => ({
        id: id(service._id),
        name: service.name,
        category: service.serviceCategory || "",
        active: service.isActive !== false,
        status: service.status || "active",
        createdAt: iso(service.createdAt)
      }));
    } else if (resource === "complaints") {
      const disputes = await ReviewDispute.find().sort({ createdAt: -1 }).limit(limit);
      rows = disputes.map((dispute) => ({
        id: id(dispute._id),
        bookingCode: dispute.bookingCode || "",
        reason: dispute.reason,
        status: dispute.status,
        priority: "review",
        createdAt: iso(dispute.createdAt)
      }));
    } else if (resource === "notifications") {
      const notifications = await InAppNotification.find().sort({ createdAt: -1 }).limit(limit);
      rows = notifications.map((notification) => ({
        id: id(notification._id),
        title: notification.title,
        role: notification.recipientRole,
        category: notification.category,
        priority: notification.priority,
        status: notification.readAt ? "read" : "unread",
        createdAt: iso(notification.createdAt)
      }));
    } else if (["banners", "analytics", "audit-logs", "settings"].includes(resource)) {
      rows = [];
    } else {
      return res.status(404).json({ message: "Resource not found" });
    }

    return res.json({ resource, rows });
  } catch (error) {
    return next(error);
  }
}

async function performAdminAction(req, res, next) {
  try {
    const action = String(req.body?.action || "").trim();
    const targetId = String(req.body?.targetId || "").trim();
    if (!action || !targetId) {
      return res.status(400).json({ message: "action and targetId are required" });
    }

    if (action === "approve-technician") {
      const partner = await Partner.findByIdAndUpdate(
        targetId,
        { $set: { isVerified: true, trustStatus: "trusted", kycStatus: "verified" } },
        { new: true }
      );
      if (!partner) return res.status(404).json({ message: "Partner not found" });
      await cache.del("admin:dashboard:v1");
      return res.json({ ok: true, action, targetId, status: partner.kycStatus });
    }

    if (action === "reject-technician" || action === "suspend-technician") {
      const partner = await Partner.findByIdAndUpdate(
        targetId,
        { $set: { isOnline: false, trustStatus: action === "suspend-technician" ? "suspended" : "review_required" } },
        { new: true }
      );
      if (!partner) return res.status(404).json({ message: "Partner not found" });
      await cache.del("admin:dashboard:v1");
      return res.json({ ok: true, action, targetId, status: partner.trustStatus });
    }

    return res.json({
      ok: true,
      action,
      targetId,
      message: "Action accepted for audit; no state transition was required."
    });
  } catch (error) {
    return next(error);
  }
}

function serializeDispute(dispute) {
  return {
    id: String(dispute._id),
    reviewId: String(dispute.reviewId),
    bookingId: String(dispute.bookingId),
    bookingCode: dispute.bookingCode || "",
    partnerId: String(dispute.partnerId),
    userId: String(dispute.userId),
    reason: dispute.reason,
    details: dispute.details || "",
    status: dispute.status,
    resolutionNote: dispute.resolutionNote || "",
    resolvedBy: dispute.resolvedBy || "",
    createdAt: dispute.createdAt ? dispute.createdAt.toISOString() : "",
    resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : ""
  };
}

async function listReviewDisputes(req, res, next) {
  try {
    const status = String(req.query.status || "open").toLowerCase();
    const query = status === "all" ? {} : { status };
    const disputes = await ReviewDispute.find(query).sort({ createdAt: -1 }).limit(100);
    return res.json({ disputes: disputes.map(serializeDispute) });
  } catch (error) {
    return next(error);
  }
}

async function resolveReviewDispute(req, res, next) {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["reviewing", "accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be reviewing, accept, or reject" });
    }

    const dispute = await ReviewDispute.findById(req.params.disputeId);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }
    const review = await Review.findById(dispute.reviewId);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    if (action === "reviewing") {
      dispute.status = "reviewing";
    } else if (action === "accept") {
      dispute.status = "accepted";
      dispute.resolvedAt = new Date();
      review.status = "hidden";
      review.disputeStatus = "resolved";
      review.resolvedAt = dispute.resolvedAt;
    } else {
      dispute.status = "rejected";
      dispute.resolvedAt = new Date();
      review.status = "published";
      review.disputeStatus = "resolved";
      review.resolvedAt = dispute.resolvedAt;
    }

    const note = String(req.body?.resolutionNote || "").slice(0, 1000);
    dispute.resolutionNote = note;
    dispute.resolvedBy = req.auth.email || req.auth.uid || "admin";
    review.adminResolution = note;
    await Promise.all([dispute.save(), review.save()]);

    await Booking.findByIdAndUpdate(review.bookingId, {
      $set: {
        "reviewSnapshot.status": review.status,
        "reviewSnapshot.disputeStatus": review.disputeStatus
      }
    });
    const ratingSummary = await recomputePartnerRating(review.partnerId);

    return res.json({
      dispute: serializeDispute(dispute),
      review: {
        id: String(review._id),
        status: review.status,
        disputeStatus: review.disputeStatus
      },
      partnerRating: ratingSummary
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  dashboard,
  listResourceRows,
  performAdminAction,
  listReviewDisputes,
  resolveReviewDispute
};
