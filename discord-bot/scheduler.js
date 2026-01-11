const logger = require('./src/logger');
require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');
const { getPendingReminders, updateReminder } = require('./src/google-sheets');
const { calculateNextDate } = require('./src/utils');
const { processReminders } = require('./src/reminder-processor');
const { getBotToken } = require('./src/config');
const { writeHeartbeat } = require('./src/scheduler-heartbeat');

logger.info('Scheduler process started.');

const token = getBotToken();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });






client.once('ready', () => {
    logger.info(`Scheduler logged in as ${client.user.tag}`);
    writeHeartbeat();
    // Schedule the task to run every minute.
    cron.schedule('* * * * *', async () => {
        try {
            await processReminders(client);
            writeHeartbeat();
        } catch (error) {
            logger.error('[scheduler] Failed to process reminders', error);
        }
    });
    logger.info('Cron job scheduled to run every minute.');
});

client.login(token).catch(err => {
    logger.error('Scheduler failed to log in:', err);
    process.exit(1);
});
