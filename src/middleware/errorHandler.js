function notFound(req, res) {
  const route = process.env.NODE_ENV === "production" ? req.path : req.originalUrl;
  res.status(404).json({ message: `Route not found: ${req.method} ${route}` });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const isZodError = error?.name === "ZodError" || Array.isArray(error?.issues);
  const isMulterLimit = error?.code === "LIMIT_FILE_SIZE";
  const isMulterError = error?.name === "MulterError";
  const isDuplicateKey = error?.code === 11000;
  const status = isZodError
    ? 400
    : isMulterLimit
      ? 413
      : isMulterError
        ? 400
        : isDuplicateKey
          ? 409
          : error.statusCode || error.status || 500;
  const payload = {
    message: isZodError
      ? "Invalid request payload"
      : isMulterLimit
        ? "Uploaded file is too large"
        : isDuplicateKey
          ? "Duplicate record already exists"
          : status >= 500
            ? "Internal server error"
            : error.message
  };

  if (process.env.NODE_ENV !== "production") {
    payload.detail = error.message;
    payload.stack = error.stack;
  }

  return res.status(status).json(payload);
}

module.exports = {
  notFound,
  errorHandler
};
