const router = require("express").Router();
const multer = require("multer");
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { rejectPlainSensitiveFields } = require("../middleware/securityGuard");
const { fcmTokenLimiter, locationUpdateLimiter, profileWriteLimiter, verificationLimiter } = require("../middleware/securityRateLimits");
const { validateUploadedImage } = require("../utils/uploadSecurity");
const controller = require("../controllers/partnerController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error("Only JPG/PNG document images are allowed");
    error.status = 415;
    return callback(error);
  }
});

router.use(verifyFirebaseToken);
router.post("/profile", profileWriteLimiter, controller.upsertProfile);
router.get("/me", controller.me);
router.post("/verification", verificationLimiter, controller.submitVerification);
router.post("/documents", verificationLimiter, upload.single("document"), validateUploadedImage(["image/jpeg", "image/png"]), rejectPlainSensitiveFields, controller.uploadDocument);
router.post("/support-tickets", profileWriteLimiter, controller.createSupportTicket);
router.post("/fcm-token", fcmTokenLimiter, controller.saveFcmToken);
router.post("/delete-account-request", profileWriteLimiter, controller.requestDeletion);
router.post("/online", profileWriteLimiter, controller.setOnline);
router.post("/offline", profileWriteLimiter, controller.setOnline);
router.patch("/location", locationUpdateLimiter, controller.updateLocation);
router.get("/statement", controller.statement);
router.get("/get-statement", controller.statement);

module.exports = router;
