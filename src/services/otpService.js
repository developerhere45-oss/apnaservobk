const crypto = require("crypto");
const admin = require("firebase-admin");
const OtpChallenge = require("../models/OtpChallenge");

const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300);
function msg91Endpoint(name, fallback) {
  const configured = String(process.env[name] || fallback).trim();
  return configured.replace("https://control.msg91.com/", "https://api.msg91.com/");
}

const MSG91_SENDOTP_URL = msg91Endpoint("MSG91_SENDOTP_URL", "https://api.msg91.com/api/v5/widget/sendOtp");
const MSG91_VERIFYOTP_URL = msg91Endpoint("MSG91_VERIFYOTP_URL", "https://api.msg91.com/api/v5/widget/verifyOtp");

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

function msg91Authkey() {
  return String(process.env.MSG91_AUTHKEY || process.env.MSG91_AUTH_KEY || "").trim();
}

function msg91TokenAuth() {
  return String(
    process.env.MSG91_TOKEN_AUTH ||
    process.env.MSG91_TOKEN ||
    process.env.MSG91_AUTH_TOKEN ||
    ""
  ).trim();
}

function msg91WidgetId() {
  return String(process.env.MSG91_WIDGET_ID || process.env.MSG91_WIDGETID || "").trim();
}

function msg91Configured() {
  return Boolean(msg91WidgetId() && (msg91TokenAuth() || msg91Authkey()));
}

function otpStatus() {
  const authkey = msg91Authkey();
  const tokenAuth = msg91TokenAuth();
  const widgetId = msg91WidgetId();
  return {
    configured: Boolean(widgetId && (tokenAuth || authkey)),
    authkeyPresent: Boolean(authkey),
    tokenAuthPresent: Boolean(tokenAuth),
    effectiveWidgetCredential: tokenAuth ? "tokenAuth" : authkey ? "authkey-compatibility" : null,
    widgetIdPresent: Boolean(widgetId),
    widgetIdMasked: widgetId ? `${widgetId.slice(0, 4)}...${widgetId.slice(-4)}` : null,
    authkeyLength: authkey.length,
    authkeyLooksMasked: /[*\s]/.test(authkey),
    tokenAuthLength: tokenAuth.length,
    tokenAuthLooksMasked: /[*\s]/.test(tokenAuth),
    credentialsIdentical: Boolean(authkey && tokenAuth && authkey === tokenAuth),
    sendEndpoint: MSG91_SENDOTP_URL,
    verifyEndpoint: MSG91_VERIFYOTP_URL
  };
}

function localFallbackAllowed() {
  return process.env.NODE_ENV !== "production" || process.env.OTP_ALLOW_LOCAL_FALLBACK === "true";
}

function maskedPhone(phone) {
  const value = String(phone || "");
  return value.length > 4 ? `${value.slice(0, 2)}******${value.slice(-4)}` : "hidden";
}

function msg91Headers(extraHeaders = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders
  };
}

async function requestJson(url, payload, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: msg91Headers(extraHeaders),
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
    const error = new Error(json.message || json.error || "OTP provider request failed");
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

function providerRejectReason(errors = []) {
  for (const item of errors) {
    const message = item?.message || item?.error || item?.description || item?.data?.message || item?.data?.error;
    if (message) {
      return String(message);
    }
  }
  return "MSG91 rejected the OTP request";
}

async function sendProviderOtp(phone) {
  const widgetId = msg91WidgetId();
  const tokenAuth = msg91TokenAuth();
  const authkey = msg91Authkey();
  const usingWidgetToken = Boolean(tokenAuth);
  const credential = tokenAuth || authkey;
  const payload = { widgetId, identifier: `91${phone}` };
  const headers = usingWidgetToken ? { token: credential } : { authkey: credential };
  const errors = [];

  try {
    const result = await requestJson(MSG91_SENDOTP_URL, payload, headers);
    if (providerAccepted(result)) {
      return result;
    }
    errors.push(result);
  } catch (error) {
    errors.push(error.details || { message: error.message, statusCode: error.statusCode });
  }

  console.warn("MSG91 OTP send rejected", {
    phone: maskedPhone(phone),
    widgetId: widgetId ? `${widgetId.slice(0, 4)}...${widgetId.slice(-4)}` : "missing",
    endpoint: MSG91_SENDOTP_URL,
    errors
  });
  const reason = providerRejectReason(errors);
  const error = new Error(reason);
  const credentialName = usingWidgetToken ? "MSG91_TOKEN_AUTH" : "MSG91_AUTHKEY";
  error.publicMessage = `MSG91 rejected ${credentialName} for this OTP Widget: ${reason}. Copy the token generated for this widget, enable Mobile Integration, disable Captcha for the native app flow, save the widget, and redeploy.`;
  error.statusCode = 400;
  error.details = { provider: "msg91", errors };
  throw error;
}

async function verifyProviderOtp(challenge, otp) {
  const tokenAuth = msg91TokenAuth();
  const authkey = msg91Authkey();
  const credential = tokenAuth || authkey;
  const headers = tokenAuth ? { token: credential } : { authkey: credential };
  try {
    const result = await requestJson(
      MSG91_VERIFYOTP_URL,
      { widgetId: msg91WidgetId(), reqId: challenge.providerRequestId, otp },
      headers
    );
    if (providerAccepted(result)) {
      challenge.consumedAt = new Date();
      await challenge.save();
      return true;
    }
  } catch (error) {
    console.warn("MSG91 OTP verify rejected", {
      phone: maskedPhone(challenge.phone),
      reason: error.message
    });
  }
  return false;
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
  otpStatus,
  verifyOtp
};
