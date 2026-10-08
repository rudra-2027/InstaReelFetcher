class AppError extends Error {
  constructor(message, { code, status, stage, retryable, retryAfterSeconds, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.code = code || "INTERNAL_ERROR";
    this.status = status || 500;
    this.stage = stage || "unknown";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isAppError(error) {
  return error instanceof AppError;
}

module.exports = {
  AppError,
  isAppError,
};
