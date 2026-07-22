const logger = require('./logger');

const createSingleFlightRunner = ({ run, writeHeartbeat, logger: runnerLogger = logger }) => {
  let running = false;

  return async () => {
    if (running) {
      runnerLogger.warn('[scheduler] Skipping overlapping tick.');
      return { skipped: true, reason: 'already_running' };
    }

    running = true;
    try {
      const result = await run();
      writeHeartbeat();
      return { ok: true, result };
    } catch (error) {
      const errorCode = String(error && (error.code || error.name) || 'REMINDER_PROCESS_FAILED')
        .replace(/[^A-Za-z0-9_.:-]+/g, '_')
        .slice(0, 80) || 'REMINDER_PROCESS_FAILED';
      runnerLogger.error({ err: error, error_code: errorCode }, '[scheduler] Failed to process reminders');
      return { ok: false, error };
    } finally {
      running = false;
    }
  };
};

module.exports = { createSingleFlightRunner };
