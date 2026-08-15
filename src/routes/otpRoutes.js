const express = require("express");
const otpController = require("../controllers/otpController");
const { loginLimiter, verificationLimiter } = require("../middleware/securityRateLimits");

const router = express.Router();

router.get("/status", otpController.status);
router.post("/send", loginLimiter, otpController.sendOtp);
router.post("/verify", verificationLimiter, otpController.verifyOtp);

module.exports = router;
