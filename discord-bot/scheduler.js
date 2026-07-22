require('dotenv').config();

const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./src/logger');
const { createDiscordRestDelivery } = require('./src/discord-rest-delivery');
const { processReminders } = require('./src/reminder-processor');
const { getBotToken } = require('./src/config');
const { writeHeartbeat } = require('./src/scheduler-heartbeat');
const { createSingleFlightRunner } = require('./src/scheduler-runner');

const scheduleReminderProcessing = (
  client,
  {
    cronImpl = cron,
    processRemindersImpl = processReminders,
    writeHeartbeatImpl = writeHeartbeat,
    loggerImpl = logger,
  } = {}
) => {
  const runOnce = createSingleFlightRunner({
    run: () => processRemindersImpl(client),
    writeHeartbeat: writeHeartbeatImpl,
    logger: loggerImpl,
  });
  const task = cronImpl.schedule('* * * * *', () => void runOnce());
  loggerImpl.info('Cron job scheduled to run every minute.');
  return { runOnce, task };
};

const startScheduler = ({
  env = process.env,
  getBotTokenImpl = getBotToken,
  createRestDeliveryImpl = createDiscordRestDelivery,
  ClientImpl = Client,
  scheduleImpl = scheduleReminderProcessing,
  loggerImpl = logger,
} = {}) => {
  loggerImpl.info('Scheduler process started.');
  const token = getBotTokenImpl();
  const deliveryMode = String(env.SCHEDULER_DISCORD_DELIVERY_MODE || 'gateway').trim().toLowerCase();

  if (deliveryMode === 'rest') {
    const client = createRestDeliveryImpl({
      token,
      apiBaseUrl: env.DISCORD_API_BASE_URL,
    });
    loggerImpl.info('[scheduler] Using Discord REST delivery mode; Gateway login is disabled.');
    const scheduled = scheduleImpl(client);
    return { mode: 'rest', client, ...scheduled };
  }

  const client = new ClientImpl({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', () => {
    loggerImpl.info(`Scheduler logged in as ${client.user.tag}`);
    scheduleImpl(client);
  });

  client.login(token).catch((error) => {
    loggerImpl.error({ err: error }, 'Scheduler failed to log in');
    process.exitCode = 1;
  });
  return { mode: 'gateway', client };
};

if (require.main === module) {
  startScheduler();
}

module.exports = {
  scheduleReminderProcessing,
  startScheduler,
};
