const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const { paymentLimiter } = require("../middleware/securityRateLimits");
const controller = require("../controllers/paymentController");

router.use(verifyFirebaseToken);
router.post("/razorpay/order", paymentLimiter, controller.createOrder);
router.post("/razorpay/verify", paymentLimiter, controller.verifyPayment);

module.exports = router;
