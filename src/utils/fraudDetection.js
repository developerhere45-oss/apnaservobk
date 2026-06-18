const FraudAlert = require("../models/FraudAlert");
const Partner = require("../models/Partner");
const User = require("../models/User");
const sendNotification = require("./sendNotification");

const OFF_APP_PATTERNS = [
  { term: "outside_app", severity: "high", regex: /\b(outside app|app ke bahar|app se bahar|without app|direct deal|direct kaam|private deal)\b/i },
  { term: "whatsapp", severity: "medium", regex: /\b(whatsapp|watsapp|wa\.me)\b/i },
  { term: "cash_direct", severity: "medium", regex: /\b(cash de dena|cash le lunga|cash payment|direct pay|direct payment)\b/i },
  { term: "upi_direct", severity: "medium", regex: /\b(gpay|google pay|phonepe|paytm|upi id|upi pe|qr bhej)\b/i },
  { term: "commission_avoid", severity: "high", regex: /\b(commission bach|commission save|app charge bach|platform fee bach)\b/i },
  { term: "phone_number", severity: "low", regex: /(?:\+?91[\s-]?)?[6-9]\d{9}\b/ }
];

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

function scanFraudText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return { flagged: false, severity: "low", matchedTerms: [] };
  }

  const matches = [];
  let severity = "low";
  for (const pattern of OFF_APP_PATTERNS) {
    if (pattern.regex.test(value)) {
      matches.push(pattern.term);
      if (SEVERITY_RANK[pattern.severity] > SEVERITY_RANK[severity]) {
        severity = pattern.severity;
      }
    }
  }

  return {
    flagged: matches.length > 0,
    severity,
    matchedTerms: [...new Set(matches)]
  };
}

async function notifyFraudWarning({ booking, actorRole, partnerId, userId, severity }) {
  const title = "Keep booking inside ApnaServo";
  const body = severity === "high"
    ? "Off-app deals can suspend the account. Use in-app quote, chat and payment only."
    : "For safety and support, keep deal/payment inside ApnaServo.";

  if (actorRole === "partner" && partnerId) {
    const partner = await Partner.findById(partnerId);
    await sendNotification({
      token: partner?.fcmToken,
      title,
      body,
      data: {
        type: "fraud:warning",
        bookingId: booking?._id || "",
        bookingCode: booking?.bookingCode || ""
      }
    });
  }

  if (actorRole === "user" && userId) {
    const user = await User.findById(userId);
    await sendNotification({
      token: user?.fcmToken,
      title,
      body: "Pay only after in-app quote approval. Do not share private payment or phone details.",
      data: {
        type: "fraud:warning",
        bookingId: booking?._id || "",
        bookingCode: booking?.bookingCode || ""
      }
    });
  }
}

async function recordFraudSignal({ booking, partnerId, userId, actorRole, source, message, metadata }) {
  const scan = scanFraudText(message);
  if (!scan.flagged) {
    return { flagged: false, severity: "low", matchedTerms: [] };
  }

  const resolvedPartnerId = partnerId || booking?.partnerId || null;
  const resolvedUserId = userId || booking?.userId || null;
  const actionTaken = scan.severity === "high" ? "review_required" : "warning_sent";
  const alert = await FraudAlert.create({
    bookingId: booking?._id || null,
    bookingCode: booking?.bookingCode || "",
    partnerId: resolvedPartnerId,
    userId: resolvedUserId,
    actorRole: actorRole || "system",
    source: source || "chat",
    severity: scan.severity,
    message: String(message || "").slice(0, 1000),
    matchedTerms: scan.matchedTerms,
    actionTaken,
    metadata: metadata || {}
  });

  if (resolvedPartnerId) {
    const update = {
      $inc: { fraudWarningCount: 1 },
      $set: {
        lastFraudWarningAt: new Date(),
        trustStatus: scan.severity === "high" ? "review_required" : "warning"
      }
    };
    await Partner.findByIdAndUpdate(resolvedPartnerId, update);
  }

  await notifyFraudWarning({
    booking,
    actorRole,
    partnerId: resolvedPartnerId,
    userId: resolvedUserId,
    severity: scan.severity
  });

  return {
    flagged: true,
    severity: scan.severity,
    matchedTerms: scan.matchedTerms,
    alertId: alert._id
  };
}

module.exports = {
  scanFraudText,
  recordFraudSignal
};
