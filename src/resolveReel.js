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

async function readVideoFromDom(page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    if (!video) {
      return null;
    }

    const sources = Array.from(video.querySelectorAll("source"))
      .map((source) => source.src)
      .filter(Boolean);

    return [video.currentSrc, video.src, ...sources].find(Boolean) || null;
  });
}

async function detectBlockedPage(page) {
  const currentUrl = page.url();
  if (BLOCKED_PATH_RE.test(currentUrl)) {
    return true;
  }

  const pageState = await page.evaluate(() => ({
    bodyText: document.body?.innerText || "",
    hasLoginForm: Boolean(document.querySelector('form input[name="username"], form input[name="password"]')),
  }));
  return (
    (pageState.hasLoginForm && /log in to instagram|login to instagram/i.test(pageState.bodyText)) ||
    /challenge_required|suspicious login attempt|confirm your identity|enter security code|account has been disabled/i.test(pageState.bodyText)
  );
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
    return candidate;
  } catch (error) {
    logger?.info("DOM_DIRECT_VALIDATION_REJECTED", {
      reelId,
      source: "dom",
      method: "head",
      candidateUrl: redactCandidateUrl(url),
      reason: `validation request failed: ${error.message}`,
    });
    return null;
  }
}

function classifyNavigationError(error) {
  if (error instanceof AppError) {
    return error;
  }

  if (error && error.name === "TimeoutError") {
    return new AppError("Extraction timed out", {
      code: "TIMEOUT",
      status: 504,
      stage: "navigate",
      cause: error,
    });
  }

  return new AppError("Unexpected resolver failure", {
    code: "INTERNAL_ERROR",
    status: 500,
    stage: "navigate",
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
  return async function resolveReel({ normalizedUrl }) {
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
          logger?.info("Network media candidate evaluated", {
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

      logger?.debug("Navigating to reel", { reelId: normalizedUrl.split("/")[4] });
      await page.goto(normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeoutMs,
      });

      await page.waitForLoadState("networkidle", {
        timeout: Math.min(config.browserTimeoutMs, 5000),
      }).catch(() => {});

      await page.waitForSelector("video", {
        timeout: Math.min(config.browserTimeoutMs, 5000),
      }).catch(() => {});

      const networkCandidate = pickVideoCandidate(networkCandidates);
      if (networkCandidate) {
        return {
          videoUrl: networkCandidate.url,
          method: "network",
        };
      }

      const domUrl = await readVideoFromDom(page);
      const domCandidate = networkCandidates.find((candidate) => candidate.url === domUrl);
      let validatedDomCandidate = domCandidate;
      if (isReusableHttpUrl(domUrl) && !domCandidate && isInstagramCdnUrl(domUrl)) {
        validatedDomCandidate = await validateDomCandidateDirectly({
          page,
          url: domUrl,
          normalizedUrl,
          config,
          logger,
          reelId: normalizedUrl.split("/")[4],
        });
      }

      if (isReusableHttpUrl(domUrl)) {
        logger?.info("DOM media candidate evaluated", {
          reelId: normalizedUrl.split("/")[4],
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

      if (await detectBlockedPage(page)) {
        throw new AppError("Instagram blocked extraction for this reel", {
          code: "UPSTREAM_BLOCKED",
          status: 502,
          stage: "blocked_page",
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

      if (page && (await detectBlockedPage(page).catch(() => false))) {
        throw new AppError("Instagram blocked extraction for this reel", {
          code: "UPSTREAM_BLOCKED",
          status: 502,
          stage: "blocked_page",
        });
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
  };
}

module.exports = {
  createResolver,
  classifyDirectValidation,
  classifyNetworkCandidate,
  isDirectVideoUrl,
  isInstagramCdnUrl,
  isVideoContentType,
  pickVideoCandidate,
  redactCandidateUrl,
};
