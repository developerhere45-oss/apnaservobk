const otpService = require("../services/otpService");

async function sendOtp(req, res, next) {
  try {
    const result = await otpService.sendOtp(req.body || {});
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const result = await otpService.verifyOtp(req.body || {});
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

function status(req, res) {
  res.json({ success: true, ...otpService.otpStatus() });
}

module.exports = {
  sendOtp,
  status,
  verifyOtp
};
