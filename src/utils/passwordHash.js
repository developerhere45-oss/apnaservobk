const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);
const PREFIX = "scrypt:v1";
const KEY_LENGTH = 64;

function safeEqual(left, right) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function hashSecret(secret) {
  const value = String(secret || "");
  if (!value) {
    throw new Error("Secret is required");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(value, salt, KEY_LENGTH);
  return `${PREFIX}:${salt}:${derived.toString("hex")}`;
}

async function verifySecret(secret, storedHash) {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== PREFIX) {
    return false;
  }

  const [, , salt, expectedHash] = parts;
  const derived = await scryptAsync(String(secret || ""), salt, KEY_LENGTH);
  return safeEqual(derived.toString("hex"), expectedHash);
}

module.exports = {
  hashSecret,
  verifySecret
};
