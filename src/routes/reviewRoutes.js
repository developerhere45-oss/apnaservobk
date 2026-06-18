const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { bookingReadLimiter, bookingWriteLimiter } = require("../middleware/securityRateLimits");
const controller = require("../controllers/reviewController");

router.use(verifyFirebaseToken);
router.post("/bookings/:bookingId", bookingWriteLimiter, controller.submitReview);
router.get("/partner/me", bookingReadLimiter, controller.listMyPartnerReviews);
router.get("/partner/:partnerId", bookingReadLimiter, controller.listPartnerReviews);
router.post("/:reviewId/dispute", bookingWriteLimiter, controller.disputeReview);

module.exports = router;
