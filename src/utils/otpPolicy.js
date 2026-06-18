function otpTtlSeconds() {
  const configured = Number(process.env.OTP_TTL_SECONDS || 300);
  if (!Number.isFinite(configured)) {
    return 300;
  }
  return Math.min(Math.max(Math.floor(configured), 60), 900);
}

function otpExpiresAt(from = new Date()) {
  return new Date(from.getTime() + otpTtlSeconds() * 1000);
}

function isOtpExpired(expiresAt, now = new Date()) {
  return !expiresAt || new Date(expiresAt).getTime() <= now.getTime();
}

module.exports = {
  isOtpExpired,
  otpExpiresAt,
  otpTtlSeconds
};
