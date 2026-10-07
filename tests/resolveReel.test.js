const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyDirectValidation, classifyNetworkCandidate, isInstagramCdnUrl, pickVideoCandidate } = require("../src/resolveReel");

test("network candidate rejects a JPEG even when its URL looks like video", () => {
  const candidate = classifyNetworkCandidate({
    url: "https://scontent.cdninstagram.com/v/t50.16885-16/clip.mp4?mime_type=video",
    resourceType: "image",
    status: 206,
    contentType: "image/jpeg",
    contentLength: "30821",
  });

  assert.equal(candidate.accepted, false);
  assert.match(candidate.reason, /image\/jpeg/);
});

test("network candidate accepts successful video content without relying on a .mp4 URL", () => {
  const candidate = classifyNetworkCandidate({
    url: "https://scontent.cdninstagram.com/v/t50.16885-16/opaque-signed-resource",
    resourceType: "media",
    status: 206,
    contentType: "video/mp4; charset=binary",
    contentLength: "1234",
  });

  assert.equal(candidate.accepted, true);
  assert.equal(pickVideoCandidate([candidate]), candidate);
});

test("network candidate rejects non-video success responses", () => {
  const candidate = classifyNetworkCandidate({
    url: "https://example.com/asset?mime_type=video",
    resourceType: "fetch",
    status: 200,
    contentType: "application/json",
  });

  assert.equal(candidate.accepted, false);
});

test("direct DOM validation accepts an Instagram CDN video HEAD response", () => {
  const candidate = classifyDirectValidation({
    url: "https://scontent.cdninstagram.com/opaque-media-resource",
    resourceType: "direct_head",
    status: 200,
    contentType: "video/mp4",
    contentLength: "16482493",
  });

  assert.equal(candidate.accepted, true);
  assert.equal(isInstagramCdnUrl(candidate.url), true);
});

test("direct DOM validation rejects image and non-200/206 responses", () => {
  const image = classifyDirectValidation({
    url: "https://scontent.cdninstagram.com/opaque-media-resource",
    resourceType: "direct_head",
    status: 206,
    contentType: "image/jpeg",
  });
  const forbidden = classifyDirectValidation({
    url: "https://scontent.cdninstagram.com/opaque-media-resource",
    resourceType: "direct_head",
    status: 403,
    contentType: "video/mp4",
  });

  assert.equal(image.accepted, false);
  assert.equal(forbidden.accepted, false);
  assert.match(forbidden.reason, /not 200 or 206/);
});
