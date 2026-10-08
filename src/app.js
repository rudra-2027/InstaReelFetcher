const express = require("express");
const { randomUUID } = require("node:crypto");

const { AppError, isAppError } = require("./errors");
const { normalizeReelUrl, parseInstagramReelUrl } = require("./url");
const { createLogger } = require("./logger");

function createResolveHandler({ resolver, config = {}, logger = createLogger(config) }) {
  return async function resolveHandler(req, res, next) {
    const inputUrl = req.query.url;
    if (!inputUrl || typeof inputUrl !== "string") {
      next(
        new AppError("Missing required query parameter: url", {
          code: "INVALID_INPUT",
          status: 400,
          stage: "validate_input",
        }),
      );
      return;
    }

    const parsed = parseInstagramReelUrl(inputUrl);
    if (!parsed) {
      next(
        new AppError("URL must be a valid Instagram Reel URL", {
          code: "INVALID_INPUT",
          status: 400,
          stage: "validate_input",
        }),
      );
      return;
    }

    const normalizedUrl = normalizeReelUrl(inputUrl);
    logger.info("Resolving reel", { requestId: req.requestId, reelId: parsed.reelId });

    try {
      const result = await resolver({
        inputUrl,
        normalizedUrl,
        reelId: parsed.reelId,
        requestId: req.requestId,
        config,
      });

      res.json({
        inputUrl,
        normalizedUrl,
        videoUrl: result.videoUrl,
        method: result.method,
      });
      logger.info("Reel resolved", { requestId: req.requestId, reelId: parsed.reelId, method: result.method });
    } catch (error) {
      next(error);
    }
  };
}

function createErrorHandler(config = {}, logger = createLogger(config)) {
  return (error, req, res, _next) => {
    const handled = isAppError(error)
      ? error
      : new AppError("Unexpected resolver failure", {
          code: "INTERNAL_ERROR",
          status: 500,
          stage: "unhandled",
          cause: error,
        });

    const fields = {
      requestId: req.requestId,
      status: handled.status,
      code: handled.code,
      stage: handled.stage,
      error: handled,
    };
    if (handled.status >= 500) {
      logger.error("Request failed", fields);
    } else {
      logger.warn("Request rejected", fields);
    }

    if (handled.retryAfterSeconds) {
      res.setHeader("Retry-After", String(handled.retryAfterSeconds));
    }

    res.status(handled.status).json({
      error: {
        code: handled.code,
        message: handled.message,
        stage: handled.stage,
        ...(handled.retryable === undefined ? {} : { retryable: handled.retryable }),
        ...(handled.retryAfterSeconds ? { retryAfterSeconds: handled.retryAfterSeconds } : {}),
      },
    });
  };
}

function createApp({ resolver, config = {}, logger = createLogger(config) }) {
  if (typeof resolver !== "function") {
    throw new Error("resolver must be a function");
  }

  const app = express();
  const resolveHandler = createResolveHandler({ resolver, config, logger });
  const errorHandler = createErrorHandler(config, logger);

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info("Request completed", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        memory: (() => {
          const memory = process.memoryUsage();
          return { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal };
        })(),
      });
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/resolve", resolveHandler);
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
  createErrorHandler,
  createResolveHandler,
};
