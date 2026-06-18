function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) {
    return "";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

function normalizeMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  return value === "image/jpg" ? "image/jpeg" : value;
}

function validateUploadedImage(allowedMimeTypes) {
  const allowed = new Set(allowedMimeTypes.map(normalizeMime));
  return function uploadedImageValidator(req, res, next) {
    const file = req.file;
    if (!file) {
      return next();
    }
    const declaredMime = normalizeMime(file.mimetype);
    const detectedMime = detectImageMime(file.buffer);
    if (!allowed.has(declaredMime) || !allowed.has(detectedMime) || declaredMime !== detectedMime) {
      return res.status(415).json({ message: "Uploaded file content does not match an allowed image type" });
    }
    return next();
  };
}

module.exports = {
  detectImageMime,
  validateUploadedImage
};
