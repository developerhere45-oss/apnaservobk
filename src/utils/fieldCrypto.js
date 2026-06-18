const crypto = require("crypto");
const { getEncryptionKey } = require("../config/env");

const PREFIX = "enc:v1:";
const AAD = Buffer.from("apnaservo-field-v1", "utf8");

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptString(value) {
  if (value === null || value === undefined) {
    return value;
  }
  const plainText = String(value);
  if (!plainText || isEncrypted(plainText)) {
    return plainText;
  }

  const key = getEncryptionKey();
  if (!key) {
    return plainText;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptString(value) {
  if (!isEncrypted(value)) {
    return value;
  }

  const key = getEncryptionKey();
  if (!key) {
    return value;
  }

  try {
    const [ivText, tagText, encryptedText] = value.slice(PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    return "";
  }
}

module.exports = {
  decryptString,
  encryptString,
  isEncrypted
};
