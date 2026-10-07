const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogger } = require("../src/logger");

test("logger emits JSON at or above its configured level", () => {
  const lines = [];
  const output = {
    log: (line) => lines.push(line),
    info: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  const logger = createLogger({ level: "info", output });

  logger.debug("hidden");
  logger.info("Request completed", { status: 200 });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "Request completed");
  assert.equal(entry.status, 200);
});

test("logger serializes errors without a stack unless debug is enabled", () => {
  const lines = [];
  const output = { error: (line) => lines.push(line) };
  const logger = createLogger({ output });

  logger.error("Request failed", { error: new Error("boom") });

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.error.message, "boom");
  assert.equal(entry.error.stack, undefined);
});
