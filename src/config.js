function parseBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  return value === "1" || value === "true";
}

function parseNumber(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function loadConfig() {
  return {
    port: parseNumber(process.env.PORT, 3000),
    browserTimeoutMs: parseNumber(process.env.BROWSER_TIMEOUT_MS, 20000),
    maxConcurrentResolves: Math.max(1, parseNumber(process.env.MAX_CONCURRENT_RESOLVES, 1)),
    upstreamCooldownMs: Math.max(0, parseNumber(process.env.UPSTREAM_COOLDOWN_MS, 30000)),
    rateLimitCooldownMs: Math.max(0, parseNumber(process.env.RATE_LIMIT_COOLDOWN_MS, 300000)),
    headless: parseBoolean(process.env.HEADLESS, true),
    debug: parseBoolean(process.env.DEBUG, false),
    logLevel: process.env.LOG_LEVEL || (parseBoolean(process.env.DEBUG, false) ? "debug" : "info"),
    browserChannel: process.env.BROWSER_CHANNEL || undefined,
    browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  };
}

module.exports = {
  loadConfig,
};
