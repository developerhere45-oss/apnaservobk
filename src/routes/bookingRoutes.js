const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/bookingController");

router.use(verifyFirebaseToken);
router.post("/", controller.createBooking);
router.get("/user", controller.listUserBookings);
router.get("/partner", controller.listPartnerBookings);
router.get("/:bookingId", controller.getBooking);
router.post("/:bookingId/accept", controller.acceptBooking);
router.post("/:bookingId/reject", controller.rejectBooking);
router.patch("/:bookingId/status", controller.updateStatus);

module.exports = router;
