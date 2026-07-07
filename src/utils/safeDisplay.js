function isEncryptedValue(value) {
  return typeof value === "string" && value.startsWith("enc:v1:");
}

function safeText(value, fallback = "Hidden") {
  if (value === null || value === undefined || value === "") return fallback;
  if (isEncryptedValue(value)) return fallback;
  return String(value);
}

function getDisplayName(entity, fallbackPrefix = "Customer") {
  if (!entity) return `Unknown ${fallbackPrefix}`;
  if (entity.name && !isEncryptedValue(entity.name)) return entity.name;
  if (entity.fullName && !isEncryptedValue(entity.fullName)) return entity.fullName;
  if (entity.userName && !isEncryptedValue(entity.userName)) return entity.userName;
  if (entity.partnerName && !isEncryptedValue(entity.partnerName)) return entity.partnerName;
  if (entity._id) return `${fallbackPrefix} #${String(entity._id).slice(-6).toUpperCase()}`;
  if (entity.id) return `${fallbackPrefix} #${String(entity.id).slice(-6).toUpperCase()}`;
  return `Unknown ${fallbackPrefix}`;
}

function maskPhone(phone) {
  if (!phone || isEncryptedValue(phone)) return "Hidden";
  const clean = String(phone).replace(/\D/g, "");
  if (clean.length < 4) return "Hidden";
  return `+91 ******${clean.slice(-4)}`;
}

function maskEmail(email) {
  const value = safeText(email, "");
  if (!value || !value.includes("@")) return "";
  const [name, domain] = value.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}***@${domain}`;
}

function id(value) {
  if (!value) return "";
  return String(value._id || value.id || value);
}

function millis(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function toSafeObject(doc) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject({ getters: true }) : doc;
}

module.exports = {
  getDisplayName,
  id,
  isEncryptedValue,
  maskEmail,
  maskPhone,
  millis,
  safeText,
  toSafeObject
};
