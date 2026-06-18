const { isProduction } = require("../config/env");

function forwardedProto(req) {
  return String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

function requireHttpsInProduction(req, res, next) {
  if (!isProduction()) {
    return next();
  }

  const proto = forwardedProto(req);
  if (req.secure || proto === "https") {
    return next();
  }

  return res.status(403).json({ message: "HTTPS required" });
}

module.exports = {
  requireHttpsInProduction
};
