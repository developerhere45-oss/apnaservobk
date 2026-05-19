const { admin } = require("../config/firebase");
const User = require("../models/User");
const Partner = require("../models/Partner");

async function verifyFirebaseToken(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ message: "Firebase ID token missing" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.auth = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid Firebase token", detail: error.message });
  }
}

async function attachUser(req, res, next) {
  try {
    const user = await User.findOne({ firebaseUid: req.auth.uid });
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }
    req.userProfile = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function attachPartner(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    req.partnerProfile = partner;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  verifyFirebaseToken,
  attachUser,
  attachPartner
};
