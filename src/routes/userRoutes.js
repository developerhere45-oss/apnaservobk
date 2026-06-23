const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { fcmTokenLimiter, profileWriteLimiter } = require("../middleware/securityRateLimits");
const controller = require("../controllers/userController");

router.use(verifyFirebaseToken);
router.post("/profile", profileWriteLimiter, controller.upsertProfile);
router.get("/me", controller.me);
router.post("/fcm-token", fcmTokenLimiter, controller.saveFcmToken);
router.post("/support-tickets/sync", profileWriteLimiter, controller.syncSupportTicket);
router.post("/delete-account-request", profileWriteLimiter, controller.requestDeletion);

module.exports = router;
