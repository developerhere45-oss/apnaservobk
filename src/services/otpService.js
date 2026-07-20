const crypto = require("crypto");
const admin = require("firebase-admin");
const OtpChallenge = require("../models/OtpChallenge");

const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300);
const MSG91_SENDOTP_URL = process.env.MSG91_SENDOTP_URL || "https://control.msg91.com/api/v5/widget/sendOtp";
const MSG91_VERIFYOTP_URL = process.env.MSG91_VERIFYOTP_URL || "https://control.msg91.com/api/v5/widget/verifyOtp";

function normalizeIndianPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const withoutCountry = digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(withoutCountry)) {
    const error = new Error("Valid 10 digit Indian mobile number is required");
    error.statusCode = 400;
    throw error;
  }
  return withoutCountry;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function msg91Configured() {
  return Boolean(process.env.MSG91_AUTHKEY && process.env.MSG91_WIDGET_ID);
}

function localFallbackAllowed() {
  return process.env.NODE_ENV !== "production" || process.env.OTP_ALLOW_LOCAL_FALLBACK === "true";
}

async function requestJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authkey: process.env.MSG91_AUTHKEY
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { message: text };
  }
  if (!response.ok) {
    const error = new Error(json.message || "OTP provider request failed");
    error.statusCode = response.status;
    error.details = json;
    throw error;
  }
  return json;
}

function providerAccepted(payload) {
  const status = String(payload.type || payload.status || payload.message || "").toLowerCase();
  return payload.success === true || payload.code === 200 || status.includes("success") || status.includes("sent") || status.includes("verified");
}

function providerRequestId(payload) {
  return String(
    payload.request_id ||
    payload.requestId ||
    payload.reqId ||
    payload.data?.request_id ||
    payload.data?.requestId ||
    payload.data?.reqId ||
    payload.message ||
    ""
  );
}

async function sendProviderOtp(phone) {
  const payload = {
    widgetId: process.env.MSG91_WIDGET_ID,
    identifier: `91${phone}`
  };
  const result = await requestJson(MSG91_SENDOTP_URL, payload);
  if (!providerAccepted(result)) {
    const error = new Error(result.message || "OTP provider rejected request");
    error.statusCode = 502;
    error.details = result;
    throw error;
  }
  return result;
}

async function verifyProviderOtp(challenge, otp) {
  const payload = {
    widgetId: process.env.MSG91_WIDGET_ID,
    reqId: challenge.providerRequestId,
    otp
  };
  const result = await requestJson(MSG91_VERIFYOTP_URL, payload);
  if (!providerAccepted(result)) {
    return false;
  }
  challenge.consumedAt = new Date();
  await challenge.save();
  return true;
}

async function firebaseCustomTokenForPhone(phone, role) {
  const uid = `${role || "user"}_phone_91${phone}`;
  const firebaseUser = await admin.auth().getUser(uid).catch((error) => {
    if (error.code === "auth/user-not-found") {
      return admin.auth().createUser({ uid, phoneNumber: `+91${phone}` });
    }
    throw error;
  });
  const token = await admin.auth().createCustomToken(firebaseUser.uid, {
    phone: `+91${phone}`,
    role: role || "user"
  });
  return { uid: firebaseUser.uid, customToken: token };
}

async function sendOtp(input = {}) {
  const phone = normalizeIndianPhone(input.phone);
  const role = input.role || "user";
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
  let provider = "local";
  let providerPayload = null;
  let requestId = "";

  if (msg91Configured()) {
    provider = "msg91";
    providerPayload = await sendProviderOtp(phone);
    requestId = providerRequestId(providerPayload);
  } else if (!localFallbackAllowed()) {
    const error = new Error("OTP provider is not configured");
    error.statusCode = 503;
    throw error;
  }

  const challenge = await OtpChallenge.createForOtp({
    phone,
    role,
    otp,
    expiresAt,
    provider,
    providerRequestId: requestId,
    providerPayload
  });

  if (provider === "local") {
    console.warn(`Local OTP fallback for ${role} +91${phone}: ${otp}`);
  }

  return {
    requestId: challenge.id,
    expiresInSeconds: OTP_TTL_SECONDS,
    provider
  };
}

async function verifyOtp(input = {}) {
  const phone = normalizeIndianPhone(input.phone);
  const otp = String(input.otp || "").trim();
  const role = input.role || "user";
  if (!/^\d{4,8}$/.test(otp)) {
    const error = new Error("Valid OTP is required");
    error.statusCode = 400;
    throw error;
  }

  const challenge = await OtpChallenge.findOne({
    _id: input.requestId,
    phone,
    role,
    purpose: "login",
    consumedAt: null
  }).sort({ createdAt: -1 });

  if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= challenge.maxAttempts) {
    const error = new Error("OTP expired or invalid");
    error.statusCode = 400;
    throw error;
  }

  let verified = false;
  if (challenge.provider === "msg91") {
    challenge.attempts += 1;
    await challenge.save();
    verified = await verifyProviderOtp(challenge, otp);
  } else {
    verified = await challenge.verifyOtp(otp);
  }

  if (!verified) {
    const error = new Error("Invalid OTP");
    error.statusCode = 400;
    throw error;
  }

  const firebase = await firebaseCustomTokenForPhone(phone, role);
  return {
    phone: `+91${phone}`,
    role,
    ...firebase
  };
}

module.exports = {
  sendOtp,
  verifyOtp
};
