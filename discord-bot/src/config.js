const logger = require('./logger');

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    logger.error(`[config] Missing ${name}`);
    process.exit(1);
  }
  return value;
};

const requireOneOf = (names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  logger.error(`[config] Missing ${names.join(' or ')}`);
  process.exit(1);
};

const getBotToken = () => {
  const { name, value } = requireOneOf(['BOT_TOKEN', 'DISCORD_BOT_TOKEN']);
  if (name !== 'BOT_TOKEN') {
    logger.warn('[config] BOT_TOKEN is not set; using DISCORD_BOT_TOKEN instead.');
  }
  return value;
};

module.exports = { requireEnv, requireOneOf, getBotToken };
