function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const status = error.statusCode || error.status || 500;
  const payload = {
    message: status >= 500 ? "Internal server error" : error.message
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
