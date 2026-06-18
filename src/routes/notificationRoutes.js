const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { bookingReadLimiter, bookingWriteLimiter } = require("../middleware/securityRateLimits");
const controller = require("../controllers/notificationController");

router.use(verifyFirebaseToken);
router.get("/", bookingReadLimiter, controller.listNotifications);
router.patch("/:notificationId/read", bookingWriteLimiter, controller.markNotificationRead);

module.exports = router;
