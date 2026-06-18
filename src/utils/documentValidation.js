const crypto = require("crypto");

const MIN_BYTES = 20 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const MIN_UNIQUE_SAMPLE_BYTES = 32;

function jpegDimensions(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) {
    return null;
  }
  const signature = buffer.slice(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === "image/png") {
    return pngDimensions(buffer);
  }
  return jpegDimensions(buffer) || pngDimensions(buffer);
}

function estimateImageQuality(buffer) {
  if (!buffer || !buffer.length) {
    return { uniqueBytes: 0, contrastScore: 0 };
  }
  const step = Math.max(1, Math.floor(buffer.length / 4096));
  const seen = new Set();
  let min = 255;
  let max = 0;
  for (let i = 0; i < buffer.length; i += step) {
    const value = buffer[i];
    seen.add(value);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    uniqueBytes: seen.size,
    contrastScore: max - min
  };
}

async function callOcrProvider(buffer, mimeType) {
  const url = String(process.env.OCR_PROVIDER_URL || "").trim();
  if (!url) {
    return { status: "not_configured", text: "" };
  }
  const auth = String(process.env.OCR_PROVIDER_AUTH || "").trim();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {})
      },
      body: JSON.stringify({
        mimeType,
        imageBase64: buffer.toString("base64")
      }),
      signal: AbortSignal.timeout(12000)
    });
    const text = await response.text();
    if (!response.ok) {
      return { status: "failed", text: "" };
    }
    try {
      const json = JSON.parse(text);
      return { status: "passed", text: String(json.text || json.fullText || "") };
    } catch {
      return { status: "passed", text };
    }
  } catch {
    return { status: "failed", text: "" };
  }
}

async function validateDocumentUpload({ buffer, mimeType, documentType, aadhaarLast4 }) {
  const reasons = [];
  if (!["image/jpeg", "image/jpg", "image/png"].includes(mimeType)) {
    reasons.push("unsupported_file_type");
  }
  if (!buffer || buffer.length < MIN_BYTES) {
    reasons.push("image_too_small_or_blurry");
  }
  if (buffer && buffer.length > MAX_BYTES) {
    reasons.push("image_too_large");
  }

  const dimensions = imageDimensions(buffer, mimeType);
  if (!dimensions || dimensions.width < 480 || dimensions.height < 320) {
    reasons.push("resolution_too_low");
  }

  const quality = estimateImageQuality(buffer);
  if (quality.uniqueBytes < MIN_UNIQUE_SAMPLE_BYTES || quality.contrastScore < 38) {
    reasons.push("low_contrast_or_blur");
  }

  let ocrStatus = "skipped";
  let ocrText = "";
  if (documentType === "id_proof") {
    const ocr = await callOcrProvider(buffer, mimeType);
    ocrStatus = ocr.status;
    ocrText = ocr.text || "";
    const normalizedText = ocrText.toLowerCase();
    const hasAadhaarWord = normalizedText.includes("aadhaar") || normalizedText.includes("aadhar") || normalizedText.includes("government of india");
    const hasLast4 = aadhaarLast4 && normalizedText.includes(String(aadhaarLast4));
    if (ocrStatus === "passed" && (!hasAadhaarWord || !hasLast4)) {
      reasons.push("aadhaar_ocr_mismatch");
    }
    if (ocrStatus === "failed") {
      reasons.push("ocr_failed");
    }
  }

  const score = Math.max(0, 100 - reasons.length * 24);
  const hardRejected = reasons.some((reason) => ["unsupported_file_type", "image_too_large", "resolution_too_low", "aadhaar_ocr_mismatch"].includes(reason));
  const validationStatus = hardRejected ? "rejected" : reasons.length ? "review" : "accepted";
  return {
    validationStatus,
    validationScore: score,
    validationReasons: reasons,
    ocrStatus,
    ocrTextHash: ocrText ? crypto.createHash("sha256").update(ocrText).digest("hex") : ""
  };
}

module.exports = {
  validateDocumentUpload,
  MAX_BYTES
};
