const { chromium, devices } = require("playwright");

const { AppError } = require("./errors");

const MOBILE_DEVICE = devices["iPhone 13"];
const BLOCKED_PATH_RE = /(login|challenge|accounts\/suspended|consent)/i;
const DIRECT_VIDEO_RE = /(\.mp4($|\?)|mime_type=video|video_versions|\/v\/t\d+\.\d+-\d+\/)/i;
const REJECTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/html",
  "application/json",
]);

function isDirectVideoUrl(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  if (value.startsWith("blob:")) {
    return false;
  }

  return /^https?:\/\//.test(value) && DIRECT_VIDEO_RE.test(value);
}

function isReusableHttpUrl(value) {
  return Boolean(value && typeof value === "string" && /^https?:\/\//.test(value) && !value.startsWith("blob:"));
}

function isVideoContentType(value) {
  return /^video\//i.test(String(value || "").split(";", 1)[0].trim());
}

function isInstagramCdnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "cdninstagram.com" || url.hostname.endsWith(".cdninstagram.com"));
  } catch {
    return false;
  }
}

function redactCandidateUrl(value) {
  try {
    const url = new URL(value);
    const parameterNames = [...url.searchParams.keys()];
    url.search = parameterNames.length
      ? `?${parameterNames.map((name) => `${encodeURIComponent(name)}=<redacted>`).join("&")}`
      : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function withLogFields(logger, fields) {
  if (!logger) {
    return logger;
  }
  return {
    debug: (message, extra) => logger.debug(message, { ...fields, ...extra }),
    info: (message, extra) => logger.info(message, { ...fields, ...extra }),
    warn: (message, extra) => logger.warn(message, { ...fields, ...extra }),
    error: (message, extra) => logger.error(message, { ...fields, ...extra }),
  };
}

function classifyMediaResponse({ url, resourceType, status, contentType, contentLength }) {
  const normalizedContentType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  let reason;
  if (status < 200 || status >= 300) {
    reason = `response status ${status} is not successful`;
  } else if (REJECTED_CONTENT_TYPES.has(normalizedContentType)) {
    reason = `response Content-Type ${normalizedContentType} is not video media`;
  } else if (!isVideoContentType(contentType)) {
    reason = `response Content-Type ${normalizedContentType || "missing"} does not confirm video media`;
  } else {
    reason = "accepted: successful response Content-Type confirms video media";
  }

  return {
    url,
    resourceType,
    status,
    contentType: contentType || "",
    contentLength: contentLength || "",
    accepted: reason.startsWith("accepted:"),
    reason,
  };
}

function classifyNetworkCandidate({ url, resourceType, status, contentType, contentLength }) {
  const isPotentialCandidate = resourceType === "media" || isDirectVideoUrl(url) || isVideoContentType(contentType);
  if (!isPotentialCandidate) {
    return null;
  }

  return classifyMediaResponse({ url, resourceType, status, contentType, contentLength });
}

function classifyDirectValidation(response) {
  const candidate = classifyMediaResponse(response);
  if (candidate.status !== 200 && candidate.status !== 206) {
    return {
      ...candidate,
      accepted: false,
      reason: `response status ${candidate.status} is not 200 or 206`,
    };
  }
  return candidate;
}

function pickVideoCandidate(candidates) {
  for (const candidate of candidates) {
    if (candidate.accepted) {
      return candidate;
    }
  }

  return null;
}

async function inspectVideoElement(page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    if (!video) {
      return null;
    }

    const sources = Array.from(video.querySelectorAll("source"))
      .map((source) => source.src)
      .filter(Boolean);

    return {
      src: video.src || null,
      currentSrc: video.currentSrc || null,
      poster: video.poster || null,
      sources,
      readyState: video.readyState,
    };
  });
}

function pickDomVideoUrl(video) {
  if (!video) {
    return null;
  }

  return [video.currentSrc, video.src, ...video.sources].find(isReusableHttpUrl) || null;
}

function logVideoElement(logger, reelId, video) {
  logger?.info("VIDEO_ELEMENT_FOUND", { reelId, found: Boolean(video) });
  if (!video) {
    return;
  }

  logger?.info("VIDEO_SRC", { reelId, value: video.src ? redactCandidateUrl(video.src) : "" });
  logger?.info("VIDEO_CURRENT_SRC", { reelId, value: video.currentSrc ? redactCandidateUrl(video.currentSrc) : "" });
  logger?.info("VIDEO_READY_STATE", { reelId, value: video.readyState });
  logger?.info("VIDEO_POSTER", { reelId, value: video.poster ? redactCandidateUrl(video.poster) : "" });
  logger?.info("VIDEO_SOURCE_CHILDREN", {
    reelId,
    values: video.sources.map(redactCandidateUrl),
  });
}

async function triggerMedia(page, logger, reelId) {
  logger?.info("MEDIA_TRIGGER_ATTEMPT", { reelId });
  const result = await page.evaluate(async () => {
    const video = document.querySelector("video");
    if (!video) {
      return { triggered: false, reason: "video element not found" };
    }

    video.scrollIntoView({ block: "center", inline: "center" });
    video.muted = true;
    try {
      await video.play();
      return { triggered: true, result: "play resolved", readyState: video.readyState };
    } catch (error) {
      return { triggered: false, result: "play rejected", reason: error.message, readyState: video.readyState };
    }
  });
  logger?.info("MEDIA_TRIGGER_RESULT", { reelId, ...result });
  return result;
}

async function waitForMediaSignal(page, timeoutMs) {
  const networkResponse = page
    .waitForResponse(
      (response) => response.status() >= 200 && response.status() < 300 && isVideoContentType(response.headers()["content-type"]),
      { timeout: timeoutMs },
    )
    .then(() => "network_video_response")
    .catch(() => null);
  const domReady = page
    .waitForFunction(
      () => {
        const video = document.querySelector("video");
        const source = video && Array.from(video.querySelectorAll("source")).find((item) => item.src);
        return Boolean(video && video.readyState >= HTMLMediaElement.HAVE_METADATA && (video.currentSrc || video.src || source?.src));
      },
      undefined,
      { timeout: timeoutMs },
    )
    .then(() => "dom_video_ready")
    .catch(() => null);

  return Promise.race([networkResponse, domReady]);
}

function sanitizePageText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

async function inspectInstagramPage(page, navigationStatus) {
  const currentUrl = page.url();
  const pageState = await page.evaluate(() => ({
    title: document.title || "",
    bodyText: document.body?.innerText || "",
    hasVideo: Boolean(document.querySelector("video")),
    hasLoginForm: Boolean(document.querySelector('form input[name="username"], form input[name="password"]')),
  }));
  const text = pageState.bodyText;
  let classification = "ok";
  if (navigationStatus === 429) {
    classification = "upstream_rate_limited";
  } else if (/accounts\/login|\/login\//i.test(currentUrl) || pageState.hasLoginForm) {
    classification = "login_required";
  } else if (BLOCKED_PATH_RE.test(currentUrl) || /challenge_required|suspicious login attempt|confirm your identity|enter security code|try again later|rate limit/i.test(text)) {
    classification = "challenge_or_rate_limited";
  } else if (/page isn'?t available|sorry, this page isn'?t available|reel unavailable|content isn'?t available/i.test(text)) {
    classification = "reel_unavailable";
  }

  return {
    navigationStatus: navigationStatus || null,
    finalUrl: redactCandidateUrl(currentUrl),
    title: sanitizePageText(pageState.title),
    summary: sanitizePageText(text),
    hasVideo: pageState.hasVideo,
    classification,
  };
}

function createCooldownState(now = () => Date.now()) {
  let until = 0;
  return {
    activate(durationMs) {
      until = Math.max(until, now() + durationMs);
    },
    remainingMs() {
      return Math.max(0, until - now());
    },
  };
}

async function validateDomCandidateDirectly({ page, url, normalizedUrl, config, logger, reelId }) {
  logger?.info("DOM_DIRECT_VALIDATION_START", {
    reelId,
    source: "dom",
    method: "head",
    candidateUrl: redactCandidateUrl(url),
  });

  try {
    const response = await page.request.fetch(url, {
      method: "HEAD",
      failOnStatusCode: false,
      maxRedirects: 5,
      timeout: Math.min(config.browserTimeoutMs, 10000),
      headers: {
        Accept: "video/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: normalizedUrl,
        "User-Agent": MOBILE_DEVICE.userAgent,
      },
    });
    const headers = response.headers();
    const candidate = classifyDirectValidation({
      url,
      resourceType: "direct_head",
      status: response.status(),
      contentType: headers["content-type"],
      contentLength: headers["content-length"] || headers["content-range"],
    });
    const logFields = {
      reelId,
      source: "dom",
      method: "head",
      candidateUrl: redactCandidateUrl(url),
      responseStatus: candidate.status,
      contentType: candidate.contentType,
      contentLength: headers["content-length"] || "",
      contentRange: headers["content-range"] || "",
    };
    logger?.info("DOM_DIRECT_VALIDATION_STATUS", logFields);
    logger?.info(candidate.accepted ? "DOM_DIRECT_VALIDATION_ACCEPTED" : "DOM_DIRECT_VALIDATION_REJECTED", {
      ...logFields,
      reason: candidate.reason,
    });
    logger?.info("DIRECT_VALIDATION_RESULT", {
      ...logFields,
      decision: candidate.accepted ? "accepted" : "rejected",
      reason: candidate.reason,
    });
    return candidate;
  } catch (error) {
    const logFields = {
      reelId,
      source: "dom",
      method: "head",
      candidateUrl: redactCandidateUrl(url),
      reason: `validation request failed: ${error.message}`,
    };
    logger?.info("DOM_DIRECT_VALIDATION_REJECTED", logFields);
    logger?.info("DIRECT_VALIDATION_RESULT", { ...logFields, decision: "rejected" });
    return null;
  }
}

function classifyNavigationError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("Instagram navigation failed", {
    code: "NAVIGATION_FAILED",
    status: 502,
    stage: "navigation_failed",
    cause: error,
  });
}

function buildLaunchOptions(config) {
  const launchOptions = {
    headless: config.headless,
  };

  if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  if (config.browserExecutablePath) {
    launchOptions.executablePath = config.browserExecutablePath;
  }

  return launchOptions;
}

async function launchBrowser(config) {
  const primaryOptions = buildLaunchOptions(config);

  try {
    return await chromium.launch(primaryOptions);
  } catch (error) {
    const hasExplicitBrowser =
      Boolean(config.browserChannel) || Boolean(config.browserExecutablePath);

    if (hasExplicitBrowser) {
      throw error;
    }

    return chromium.launch({
      headless: config.headless,
      channel: "chrome",
    });
  }
}

function createResolver(config, logger) {
  const inFlightByReel = new Map();
  const pending = [];
  let activeResolves = 0;
  const challengeCooldown = createCooldownState();
  const rateLimitCooldown = createCooldownState();
  const maxConcurrentResolves = config.maxConcurrentResolves || 1;
  const upstreamCooldownMs = config.upstreamCooldownMs ?? 30000;
  const rateLimitCooldownMs = config.rateLimitCooldownMs ?? 300000;

  function runWithLimit(operation) {
    return new Promise((resolve, reject) => {
      const start = () => {
        activeResolves += 1;
        operation().then(resolve, reject).finally(() => {
          activeResolves -= 1;
          pending.shift()?.();
        });
      };
      if (activeResolves < maxConcurrentResolves) {
        start();
      } else {
        pending.push(start);
      }
    });
  }

  async function resolveReelOnce({ normalizedUrl, reelId: requestedReelId, requestId }) {
    const attemptLogger = withLogFields(logger, { requestId });
    let browser;
    let context;
    let page;
    const networkCandidates = [];

    try {
      browser = await launchBrowser(config);
      context = await browser.newContext({
        ...MOBILE_DEVICE,
        viewport: { width: 390, height: 844 },
        locale: "en-US",
      });
      page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
      });

      page.on("response", (response) => {
        const responseUrl = response.url();
        const headers = response.headers();
        const candidate = classifyNetworkCandidate({
          url: responseUrl,
          resourceType: response.request().resourceType(),
          status: response.status(),
          contentType: headers["content-type"],
          contentLength: headers["content-length"],
        });
        if (candidate) {
          networkCandidates.push(candidate);
          attemptLogger?.info("Network media candidate evaluated", {
            reelId: normalizedUrl.split("/")[4],
            source: "network",
            method: "network",
            candidateUrl: redactCandidateUrl(candidate.url),
            resourceType: candidate.resourceType,
            responseStatus: candidate.status,
            contentType: candidate.contentType,
            contentLength: candidate.contentLength,
            decision: candidate.accepted ? "accepted" : "rejected",
            reason: candidate.reason,
          });
        }
      });

      const reelId = requestedReelId || normalizedUrl.split("/")[4];
      attemptLogger?.debug("Navigating to reel", { reelId });
      const navigationResponse = await page.goto(normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });
      const initialPage = await inspectInstagramPage(page, navigationResponse?.status());
      attemptLogger?.info("Instagram navigation completed", { reelId, ...initialPage });
      if (initialPage.classification === "upstream_rate_limited") {
        rateLimitCooldown.activate(rateLimitCooldownMs);
        throw new AppError("Instagram rate limited this instance", {
          code: "UPSTREAM_RATE_LIMITED",
          status: 503,
          stage: "upstream_rate_limited",
          retryable: true,
          retryAfterSeconds: Math.ceil(rateLimitCooldown.remainingMs() / 1000),
        });
      }
      if (initialPage.classification === "login_required") {
        throw new AppError("Instagram requires login for this reel", {
          code: "LOGIN_REQUIRED",
          status: 401,
          stage: "login_required",
        });
      }
      if (initialPage.classification === "challenge_or_rate_limited") {
        challengeCooldown.activate(upstreamCooldownMs);
        throw new AppError("Instagram temporarily blocked or rate-limited this instance", {
          code: "UPSTREAM_BLOCKED",
          status: 502,
          stage: "challenge_or_rate_limited",
        });
      }
      if (initialPage.classification === "reel_unavailable") {
        throw new AppError("Instagram Reel is unavailable", {
          code: "REEL_UNAVAILABLE",
          status: 404,
          stage: "reel_unavailable",
        });
      }

      await page.waitForLoadState("networkidle", {
        timeout: Math.min(config.browserTimeoutMs, 5000),
      }).catch(() => {});

      await page.waitForSelector("video", {
        timeout: Math.min(config.browserTimeoutMs, 5000),
      }).catch(() => {});

      let video = await inspectVideoElement(page);
      logVideoElement(attemptLogger, reelId, video);

      let networkCandidate = pickVideoCandidate(networkCandidates);
      if (networkCandidate) {
        return {
          videoUrl: networkCandidate.url,
          method: "network",
        };
      }

      let domUrl = pickDomVideoUrl(video);
      if (!isReusableHttpUrl(domUrl)) {
        const mediaWait = waitForMediaSignal(page, Math.min(config.browserTimeoutMs, 5000));
        await triggerMedia(page, attemptLogger, reelId);
        const mediaSignal = await mediaWait;
        if (!mediaSignal) {
          attemptLogger?.info("NETWORK_VIDEO_WAIT_TIMEOUT", { reelId });
        } else {
          attemptLogger?.info("NETWORK_VIDEO_WAIT_RESULT", { reelId, signal: mediaSignal });
        }

        video = await inspectVideoElement(page);
        logVideoElement(attemptLogger, reelId, video);
        domUrl = pickDomVideoUrl(video);
        networkCandidate = pickVideoCandidate(networkCandidates);
        if (networkCandidate) {
          return {
            videoUrl: networkCandidate.url,
            method: "network",
          };
        }
      }

      attemptLogger?.info("DOM_CANDIDATE_FOUND", {
        reelId,
        found: isReusableHttpUrl(domUrl),
        candidateUrl: isReusableHttpUrl(domUrl) ? redactCandidateUrl(domUrl) : "",
      });
      const domCandidate = networkCandidates.find((candidate) => candidate.url === domUrl);
      let validatedDomCandidate = domCandidate;
      if (isReusableHttpUrl(domUrl) && !domCandidate && isInstagramCdnUrl(domUrl)) {
        validatedDomCandidate = await validateDomCandidateDirectly({
          page,
          url: domUrl,
          normalizedUrl,
          config,
          logger: attemptLogger,
          reelId,
        });
      }

      if (isReusableHttpUrl(domUrl)) {
        attemptLogger?.info("DOM media candidate evaluated", {
          reelId,
          source: "dom",
          method: "dom",
          candidateUrl: redactCandidateUrl(domUrl),
          resourceType: validatedDomCandidate?.resourceType || "unknown",
          responseStatus: validatedDomCandidate?.status || "unknown",
          contentType: validatedDomCandidate?.contentType || "unknown",
          contentLength: validatedDomCandidate?.contentLength || "unknown",
          decision: validatedDomCandidate?.accepted ? "accepted" : "rejected",
          reason: validatedDomCandidate?.reason || "no browser response confirmed video media for DOM URL",
        });

        if (validatedDomCandidate?.accepted) {
          return {
            videoUrl: domUrl,
            method: "dom",
          };
        }
      }

      const finalPage = await inspectInstagramPage(page, navigationResponse?.status());
      attemptLogger?.info("Instagram extraction page classification", { reelId, ...finalPage });
      if (finalPage.classification === "upstream_rate_limited") {
        rateLimitCooldown.activate(rateLimitCooldownMs);
        throw new AppError("Instagram rate limited this instance", {
          code: "UPSTREAM_RATE_LIMITED",
          status: 503,
          stage: "upstream_rate_limited",
          retryable: true,
          retryAfterSeconds: Math.ceil(rateLimitCooldown.remainingMs() / 1000),
        });
      }
      if (finalPage.classification === "login_required") {
        throw new AppError("Instagram requires login for this reel", {
          code: "LOGIN_REQUIRED",
          status: 401,
          stage: "login_required",
        });
      }
      if (finalPage.classification === "challenge_or_rate_limited") {
        challengeCooldown.activate(upstreamCooldownMs);
        throw new AppError("Instagram temporarily blocked or rate-limited this instance", {
          code: "UPSTREAM_BLOCKED",
          status: 502,
          stage: "challenge_or_rate_limited",
        });
      }
      if (finalPage.classification === "reel_unavailable") {
        throw new AppError("Instagram Reel is unavailable", {
          code: "REEL_UNAVAILABLE",
          status: 404,
          stage: "reel_unavailable",
        });
      }

      if (!finalPage.hasVideo) {
        throw new AppError("Reel video element was not found", {
          code: "VIDEO_NOT_FOUND",
          status: 404,
          stage: "video_not_found",
        });
      }

      throw new AppError("Direct video URL not found", {
        code: "EXTRACTION_FAILED",
        status: 404,
        stage: "network_fallback",
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw classifyNavigationError(error);
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }

      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  return function resolveReel(params) {
    const reelId = params.reelId || params.normalizedUrl.split("/")[4];
    const existing = inFlightByReel.get(reelId);
    if (existing) {
      logger?.info("Resolve request deduplicated", { requestId: params.requestId, reelId });
      return existing;
    }

    const rateLimitRetryAfterMs = rateLimitCooldown.remainingMs();
    if (rateLimitRetryAfterMs) {
      const retryAfterSeconds = Math.ceil(rateLimitRetryAfterMs / 1000);
      logger?.warn("Resolve rejected during upstream rate-limit cooldown", { requestId: params.requestId, reelId, retryAfterSeconds });
      return Promise.reject(new AppError("Instagram rate limit cooldown is active", {
        code: "UPSTREAM_RATE_LIMITED",
        status: 503,
        stage: "upstream_rate_limited",
        retryable: true,
        retryAfterSeconds,
      }));
    }

    const challengeRetryAfterMs = challengeCooldown.remainingMs();
    if (challengeRetryAfterMs) {
      logger?.warn("Resolve rejected during upstream challenge cooldown", { requestId: params.requestId, reelId, retryAfterMs: challengeRetryAfterMs });
      return Promise.reject(new AppError("Instagram cooldown is active after an upstream challenge", {
        code: "UPSTREAM_COOLDOWN",
        status: 429,
        stage: "challenge_or_rate_limited",
      }));
    }

    const operation = runWithLimit(() => resolveReelOnce(params));
    inFlightByReel.set(reelId, operation);
    operation.finally(() => inFlightByReel.delete(reelId)).catch(() => {});
    return operation;
  };
}

module.exports = {
  createResolver,
  classifyDirectValidation,
  classifyNetworkCandidate,
  createCooldownState,
  inspectInstagramPage,
  isDirectVideoUrl,
  isInstagramCdnUrl,
  isVideoContentType,
  pickVideoCandidate,
  redactCandidateUrl,
};
