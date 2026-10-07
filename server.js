const { createApp } = require("./src/app");
const { createResolver } = require("./src/resolveReel");
const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");

const config = loadConfig();
const logger = createLogger(config);
const resolver = createResolver(config, logger);
const app = createApp({ resolver, config, logger });

app.listen(config.port, () => {
  logger.info("Server listening", { port: config.port });
});
