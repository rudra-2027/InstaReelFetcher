const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(value) {
  const level = String(value || "info").toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : "info";
}

function serializeError(error, includeStack) {
  if (!error) {
    return undefined;
  }

  const details = {
    name: error.name,
    message: error.message,
    code: error.code,
    stage: error.stage,
  };

  if (includeStack && error.stack) {
    details.stack = error.stack;
  }

  return details;
}

function createLogger({ level = "info", debug = false, output = console } = {}) {
  const minimumLevel = LEVELS[normalizeLevel(level)];

  function log(logLevel, message, fields = {}) {
    if (LEVELS[logLevel] < minimumLevel) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message,
      ...fields,
    };
    const write = output[logLevel] || output.log;
    write.call(output, JSON.stringify(entry));
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields = {}) => {
      const { error, ...rest } = fields;
      log("error", message, {
        ...rest,
        ...(error ? { error: serializeError(error, debug) } : {}),
      });
    },
  };
}

module.exports = {
  createLogger,
  normalizeLevel,
};
