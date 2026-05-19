const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/paymentController");

router.use(verifyFirebaseToken);
router.post("/razorpay/order", controller.createOrder);
router.post("/razorpay/verify", controller.verifyPayment);

module.exports = router;
