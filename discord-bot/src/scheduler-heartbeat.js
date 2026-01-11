const fs = require('fs');
const logger = require('./logger');

const DEFAULT_HEARTBEAT_PATH = '/tmp/discord-scheduler-heartbeat';

const getHeartbeatPath = () => process.env.SCHEDULER_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;

const writeHeartbeat = (path = getHeartbeatPath()) => {
  try {
    fs.writeFileSync(path, new Date().toISOString());
    return true;
  } catch (error) {
    logger.warn({ err: error }, '[scheduler] Failed to write heartbeat.');
    return false;
  }
};

module.exports = { DEFAULT_HEARTBEAT_PATH, getHeartbeatPath, writeHeartbeat };
