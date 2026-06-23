const mongoose = require("mongoose");
const { z } = require("zod");
const Review = require("../models/Review");
const ReviewDispute = require("../models/ReviewDispute");
const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");
const { reliableNotify } = require("../utils/reliableNotify");
const { recomputePartnerRating } = require("../utils/ratingAggregation");
const { emitAdminEvent } = require("../sockets/bookingSocket");

const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(600).optional()
});

const disputeSchema = z.object({
  reason: z.enum(["revenge_review", "fake_claim", "abusive_language", "wrong_booking", "other"]).optional(),
  details: z.string().min(5).max(800).optional()
});

function bookingIdFilter(value) {
  const raw = String(value || "").trim();
  if (mongoose.isValidObjectId(raw)) {
    return { _id: raw };
  }
  return { bookingCode: raw };
}

function userRecipient(user) {
  return user ? {
    role: "user",
    userId: user._id,
    firebaseUid: user.firebaseUid,
    token: user.fcmToken,
    phone: user.phone
  } : null;
}

function partnerRecipient(partner) {
  return partner ? {
    role: "partner",
    partnerId: partner._id,
    firebaseUid: partner.firebaseUid,
    token: partner.fcmToken,
    phone: partner.phone
  } : null;
}

function serializeReview(review) {
  return {
    id: String(review._id),
    bookingId: String(review.bookingId),
    partnerId: String(review.partnerId),
    rating: review.rating,
    comment: review.comment || "",
    status: review.status,
    disputeStatus: review.disputeStatus,
    createdAt: review.createdAt ? review.createdAt.toISOString() : ""
  };
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
    createdAt: dispute.createdAt ? dispute.createdAt.toISOString() : "",
    resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : ""
  };
}

async function submitReview(req, res, next) {
  try {
    const body = reviewSchema.parse(req.body || {});
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "Customer profile not found" });
    }

    const booking = await Booking.findOne({
      ...bookingIdFilter(req.params.bookingId),
      userId: user._id
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status !== "completed" || !booking.partnerId) {
      return res.status(403).json({ message: "Only completed bookings can be reviewed" });
    }

    const existing = await Review.findOne({ bookingId: booking._id });
    if (existing) {
      return res.status(409).json({ message: "This booking is already reviewed", review: serializeReview(existing) });
    }

    const review = await Review.create({
      bookingId: booking._id,
      userId: user._id,
      partnerId: booking.partnerId,
      rating: body.rating,
      comment: body.comment || "",
      status: "published",
      disputeStatus: "none"
    });

    booking.reviewSnapshot = {
      reviewId: review._id,
      rating: review.rating,
      status: review.status,
      disputeStatus: review.disputeStatus,
      reviewedAt: review.createdAt
    };
    await booking.save();
    const ratingSummary = await recomputePartnerRating(booking.partnerId);

    const partner = await Partner.findById(booking.partnerId);
    await reliableNotify({
      recipients: [partnerRecipient(partner)],
      title: body.rating <= 2 ? "Low Rating Received" : "New Customer Review",
      body: body.rating <= 2
        ? `Customer rated ${body.rating}/5 for ${booking.serviceName}. You can dispute if it is unfair.`
        : `Customer rated ${body.rating}/5 for ${booking.serviceName}.`,
      category: "review",
      priority: body.rating <= 2 ? "high" : "normal",
      data: {
        type: "review:created",
        reviewId: review._id,
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
        rating: review.rating
      }
    });

    return res.status(201).json({ review: serializeReview(review), partnerRating: ratingSummary });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "This booking is already reviewed" });
    }
    return next(error);
  }
}

async function listPartnerReviews(req, res, next) {
  try {
    const partnerId = req.params.partnerId;
    if (!mongoose.isValidObjectId(partnerId)) {
      return res.status(400).json({ message: "Invalid partner id" });
    }
    const reviews = await Review.find({ partnerId, status: "published" }).sort({ createdAt: -1 }).limit(50);
    return res.json({ reviews: reviews.map(serializeReview) });
  } catch (error) {
    return next(error);
  }
}

async function listMyPartnerReviews(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    const reviews = await Review.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(80);
    return res.json({ reviews: reviews.map(serializeReview) });
  } catch (error) {
    return next(error);
  }
}

async function disputeReview(req, res, next) {
  try {
    const body = disputeSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const review = await Review.findOne({ _id: req.params.reviewId, partnerId: partner._id });
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }
    if (review.status === "hidden") {
      return res.status(409).json({ message: "Review is already hidden" });
    }

    const openDispute = await ReviewDispute.findOne({
      reviewId: review._id,
      status: { $in: ["open", "reviewing"] }
    });
    if (openDispute) {
      return res.status(409).json({ message: "Dispute already open", dispute: serializeDispute(openDispute) });
    }

    const booking = await Booking.findById(review.bookingId);
    const dispute = await ReviewDispute.create({
      reviewId: review._id,
      bookingId: review.bookingId,
      bookingCode: booking?.bookingCode || "",
      partnerId: partner._id,
      userId: review.userId,
      reason: body.reason || "other",
      details: body.details || ""
    });
    emitAdminEvent("complaint:submitted", {
      disputeId: String(dispute._id),
      bookingId: String(dispute.bookingId),
      bookingCode: dispute.bookingCode || "",
      userId: String(dispute.userId),
      reason: dispute.reason,
      status: dispute.status
    });

    review.status = "under_dispute";
    review.disputeStatus = "open";
    review.disputedAt = new Date();
    await review.save();
    if (booking) {
      booking.reviewSnapshot.status = review.status;
      booking.reviewSnapshot.disputeStatus = review.disputeStatus;
      await booking.save();
    }
    const ratingSummary = await recomputePartnerRating(partner._id);

    const user = await User.findById(review.userId);
    await reliableNotify({
      recipients: [userRecipient(user)],
      title: "Review Under Dispute",
      body: `Your ${review.rating}/5 review for booking ${booking?.bookingCode || ""} is under admin review.`,
      category: "review_dispute",
      priority: "normal",
      data: {
        type: "review:disputed",
        reviewId: review._id,
        disputeId: dispute._id,
        bookingId: review.bookingId,
        bookingCode: booking?.bookingCode || ""
      }
    });

    return res.status(201).json({
      dispute: serializeDispute(dispute),
      review: serializeReview(review),
      partnerRating: ratingSummary
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  submitReview,
  listPartnerReviews,
  listMyPartnerReviews,
  disputeReview
};
