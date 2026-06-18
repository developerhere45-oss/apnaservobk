function cdnFriendlyHeaders(req, res, next) {
  res.setHeader("Vary", "Authorization, Origin");

  if (req.method !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    return next();
  }

  if (req.path === "/health" || req.path === "/ready") {
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=30");
    return next();
  }

  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "private, no-store");
  }

  return next();
}

module.exports = {
  cdnFriendlyHeaders
};
