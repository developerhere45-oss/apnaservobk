const router = require("express").Router();
const multer = require("multer");
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { bookingCreateLimiter, bookingReadLimiter, bookingWriteLimiter, chatReadLimiter } = require("../middleware/securityRateLimits");
const { validateUploadedImage } = require("../utils/uploadSecurity");
const controller = require("../controllers/bookingController");
const chatController = require("../controllers/chatController");

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error("Only JPG/PNG/WebP proof photos are allowed");
    error.status = 415;
    return callback(error);
  }
});

router.use(verifyFirebaseToken);
router.post("/", bookingCreateLimiter, controller.createBooking);
router.get("/user", bookingReadLimiter, controller.listUserBookings);
router.get("/partner", bookingReadLimiter, controller.listPartnerBookings);
router.get("/:bookingId", bookingReadLimiter, controller.getBooking);
router.get("/:bookingId/tracking", bookingReadLimiter, controller.getTracking);
router.post("/:bookingId/calls", bookingWriteLimiter, controller.createCallLog);
router.post("/:bookingId/sos", bookingWriteLimiter, controller.createTechnicianSos);
router.post("/:bookingId/proof-photos", bookingWriteLimiter, proofUpload.single("photo"), validateUploadedImage(["image/jpeg", "image/png", "image/webp"]), controller.uploadJobProofPhoto);
router.post("/:bookingId/revisit-request", bookingWriteLimiter, controller.createRevisitRequest);
router.post("/:bookingId/quote/counter", bookingWriteLimiter, controller.counterOfferQuote);
router.post("/:bookingId/payment-submitted", bookingWriteLimiter, controller.submitDirectPayment);
router.get("/:bookingId/chat/messages", chatReadLimiter, chatController.listMessages);
router.post("/:bookingId/chat/messages", bookingWriteLimiter, chatController.sendMessage);
router.patch("/:bookingId/chat/seen", bookingWriteLimiter, chatController.markSeen);
router.post("/:bookingId/chat/monitor", bookingWriteLimiter, controller.monitorBookingChat);
router.post("/:bookingId/no-response-report", bookingWriteLimiter, controller.reportCustomerNoResponse);
router.post("/:bookingId/accept", bookingWriteLimiter, controller.acceptBooking);
router.post("/:bookingId/reject", bookingWriteLimiter, controller.rejectBooking);
router.patch("/:bookingId/status", bookingWriteLimiter, controller.updateStatus);

module.exports = router;
