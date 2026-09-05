const { getPublishedConfig } = require("./appControl");

const DEFAULT_INTENTS = [
  { id: "booking_status", keywords: ["booking", "status", "track", "partner kaha", "kab ayega", "kab aayega", "late", "delay"], reply: "I understand you need an update on your booking. Please open My Bookings to view the latest live status. I have also linked this conversation to your most recent booking for our support team." },
  { id: "cancel_booking", keywords: ["cancel", "cancellation", "booking hata", "nahi chahiye"], reply: "I can help with cancellation. Open My Bookings, select the booking and choose Cancel if it is still eligible. If that option is unavailable, your support ticket is already open and our team will review it." },
  { id: "payment", keywords: ["payment", "paid", "paisa", "refund", "upi", "card", "money", "amount", "bill"], reply: "I’m sorry you’re facing a payment issue. Please share the booking ID and transaction reference, but never send your OTP, UPI PIN or card PIN. Your ticket has been created for secure review." },
  { id: "partner", keywords: ["partner", "technician", "professional", "arrive", "arrival", "nahi aya", "nhi aya", "not arrived"], reply: "I understand the service professional has not arrived or you need their status. Please check the live booking tracker. Your ticket is open so our team can follow up with the assigned partner." },
  { id: "quality", keywords: ["bad service", "quality", "complaint", "damage", "behaviour", "behavior", "rude", "ganda", "kharab"], reply: "I’m sorry the service did not meet expectations. Your complaint ticket has been created. Please describe what happened and attach clear photos in the booking chat if available; our support team will investigate." },
  { id: "safety", keywords: ["unsafe", "danger", "emergency", "fraud", "scam", "threat", "harassment", "chori"], reply: "Your safety is our priority. Move to a safe place and contact local emergency services if there is immediate danger. I have marked this ticket urgent for the ApnaServo support team." },
  { id: "login", keywords: ["login", "otp", "sign in", "account", "profile", "number change"], reply: "I can help with your account issue. Please confirm the step where you are stuck and the error shown on screen. Never share an OTP or password with anyone, including support." },
  { id: "greeting", keywords: ["hi", "hello", "hey", "namaste", "hii", "helo"], reply: "Namaste! How can I help you today? You can ask about a booking, partner arrival, payment, cancellation, service quality or your account." }
];

function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ").replace(/(.)\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ").trim();
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function keywordMatches(text, keyword) {
  const phrase = normalized(keyword);
  if (!phrase) return false;
  if (text.includes(phrase)) return true;
  if (phrase.includes(" ")) return false;
  return text.split(" ").some((token) => token.length >= 4 && phrase.length >= 4 && editDistance(token, phrase) <= 1);
}

async function supportBotReply(message, platform = "android") {
  const { config } = await getPublishedConfig({ app: "customer", platform });
  const settings = config.support || {};
  const intents = Array.isArray(settings.intents) && settings.intents.length ? settings.intents : DEFAULT_INTENTS;
  const text = normalized(message);
  const match = intents.find((intent) => (intent.keywords || []).some((keyword) => keywordMatches(text, keyword)));
  return {
    enabled: settings.enabled !== false,
    intent: match?.id || "general",
    reply: match?.reply || settings.fallbackReply || "Thank you for explaining the issue. I’ve created a support ticket and shared your message with our team. Please send your booking ID and any relevant details so we can assist you faster.",
    typingDelayMs: Math.max(600, Math.min(Number(settings.typingDelayMs || 1400), 5000))
  };
}

module.exports = { DEFAULT_INTENTS, normalized, keywordMatches, supportBotReply };
