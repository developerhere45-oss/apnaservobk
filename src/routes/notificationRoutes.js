const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { bookingReadLimiter, bookingWriteLimiter, fcmTokenLimiter } = require("../middleware/securityRateLimits");
const controller = require("../controllers/notificationController");

router.use(verifyFirebaseToken);
router.post("/device-token", fcmTokenLimiter, controller.saveDeviceToken);
router.delete("/device-token", fcmTokenLimiter, controller.deleteDeviceToken);
router.get("/my-notifications", bookingReadLimiter, controller.listNotifications);
router.patch("/read-all", bookingWriteLimiter, controller.markAllRead);
router.get("/", bookingReadLimiter, controller.listNotifications);
router.patch("/:notificationId/read", bookingWriteLimiter, controller.markNotificationRead);

module.exports = router;
