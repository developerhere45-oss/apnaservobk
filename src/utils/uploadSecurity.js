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

function detectDocumentMime(buffer) {
  const imageMime = detectImageMime(buffer);
  if (imageMime) {
    return imageMime;
  }
  if (buffer && buffer.length >= 5 && buffer.slice(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  return "";
}

function normalizeMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  if (value === "application/x-pdf") return "application/pdf";
  return value;
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

function validateUploadedDocument(allowedMimeTypes) {
  const allowed = new Set(allowedMimeTypes.map(normalizeMime));
  return function uploadedDocumentValidator(req, res, next) {
    const file = req.file;
    if (!file) {
      return next();
    }
    const declaredMime = normalizeMime(file.mimetype);
    const detectedMime = detectDocumentMime(file.buffer);
    if (!allowed.has(declaredMime) || !allowed.has(detectedMime) || declaredMime !== detectedMime) {
      return res.status(415).json({ message: "Upload a valid JPG, PNG, or PDF document" });
    }
    return next();
  };
}

module.exports = {
  detectImageMime,
  detectDocumentMime,
  validateUploadedImage,
  validateUploadedDocument
};
