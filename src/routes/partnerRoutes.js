const router = require("express").Router();
const multer = require("multer");
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { rejectPlainSensitiveFields } = require("../middleware/securityGuard");
const { fcmTokenLimiter, locationUpdateLimiter, profileWriteLimiter, verificationLimiter } = require("../middleware/securityRateLimits");
const { validateUploadedImage, validateUploadedDocument } = require("../utils/uploadSecurity");
const controller = require("../controllers/partnerController");

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png"].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error("Only JPG/PNG document images are allowed");
    error.status = 415;
    return callback(error);
  }
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png", "application/pdf", "application/x-pdf"].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error("Only JPG, PNG, or PDF documents are allowed");
    error.status = 415;
    return callback(error);
  }
});

router.use(verifyFirebaseToken);
router.post("/profile", profileWriteLimiter, controller.upsertProfile);
router.get("/me", controller.me);
router.post("/staff/session", profileWriteLimiter, controller.staffSession);
router.get("/staff/bookings", controller.listStaffBookings);
router.patch("/staff/online", profileWriteLimiter, controller.setStaffOnline);
router.post("/laundry/staff", profileWriteLimiter, controller.addLaundryStaff);
router.patch("/staff/bookings/:bookingId/status", profileWriteLimiter, controller.updateStaffBookingStatus);
router.patch("/laundry/bookings/:bookingId/assign-staff", profileWriteLimiter, controller.assignLaundryStaff);
router.post("/verification", verificationLimiter, controller.submitVerification);
router.post("/profile-photo", verificationLimiter, imageUpload.single("photo"), validateUploadedImage(["image/jpeg", "image/png"]), rejectPlainSensitiveFields, controller.uploadProfilePhoto);
router.post("/documents", verificationLimiter, documentUpload.single("document"), validateUploadedDocument(["image/jpeg", "image/png", "application/pdf"]), rejectPlainSensitiveFields, controller.uploadDocument);
router.post("/support-tickets", profileWriteLimiter, controller.createSupportTicket);
router.post("/fcm-token", fcmTokenLimiter, controller.saveFcmToken);
router.post("/delete-account-request", profileWriteLimiter, controller.requestDeletion);
router.post("/online", profileWriteLimiter, controller.setOnline);
router.post("/offline", profileWriteLimiter, controller.setOnline);
router.patch("/location", locationUpdateLimiter, controller.updateLocation);
router.get("/statement", controller.statement);
router.get("/get-statement", controller.statement);

module.exports = router;
