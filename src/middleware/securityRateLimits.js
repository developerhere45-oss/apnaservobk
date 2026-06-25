const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

function rateLimitKey(req) {
  if (req.auth?.uid) {
    return `uid:${req.auth.uid}`;
  }
  return `ip:${ipKeyGenerator(req.ip || "0.0.0.0")}`;
}

function limiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: rateLimitKey,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message }
  });
}

const bookingCreateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 12,
  message: "Too many booking attempts. Please wait and try again."
});

const bookingWriteLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 40,
  message: "Too many booking updates. Please wait and try again."
});

const bookingReadLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many booking reads. Please wait and try again."
});

const chatReadLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 180,
  message: "Too many chat refreshes. Please wait and try again."
});

const paymentLimiter = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: "Too many payment attempts. Please wait and try again."
});

const profileWriteLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: "Too many profile updates. Please wait and try again."
});

const fcmTokenLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: "Too many token updates. Please wait and try again."
});

const adminNotificationLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: "Too many admin notification requests. Please wait and try again."
});

const locationUpdateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 90,
  message: "Too many location updates. Please wait and try again."
});

const verificationLimiter = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  message: "Too many verification attempts. Please wait and try again."
});

module.exports = {
  adminNotificationLimiter,
  bookingCreateLimiter,
  bookingReadLimiter,
  bookingWriteLimiter,
  chatReadLimiter,
  fcmTokenLimiter,
  locationUpdateLimiter,
  paymentLimiter,
  profileWriteLimiter,
  verificationLimiter
};
