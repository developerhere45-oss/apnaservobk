const crypto = require("crypto");
const { getEncryptionKey } = require("../config/env");

const PREFIX = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const AAD = Buffer.from("apnaservo-field-v1", "utf8");

function isEncrypted(value) {
  return typeof value === "string" && (value.startsWith(PREFIX) || value.startsWith(PREFIX_V2));
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
  return `${PREFIX_V2}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
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
    const isV2 = value.startsWith(PREFIX_V2);
    const prefix = isV2 ? PREFIX_V2 : PREFIX;
    const encoding = isV2 ? "hex" : "base64";
    const [ivText, tagText, encryptedText] = value.slice(prefix.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, encoding));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagText, encoding));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, encoding)),
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
