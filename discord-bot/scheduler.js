const logger = require('./src/logger');
require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');
const { createDiscordRestDelivery } = require('./src/discord-rest-delivery');
const { getPendingReminders, updateReminder } = require('./src/google-sheets');
const { calculateNextDate } = require('./src/utils');
const { processReminders } = require('./src/reminder-processor');
const { getBotToken } = require('./src/config');
const { writeHeartbeat } = require('./src/scheduler-heartbeat');

logger.info('Scheduler process started.');

const token = getBotToken();
const deliveryMode = String(process.env.SCHEDULER_DISCORD_DELIVERY_MODE || 'gateway').trim().toLowerCase();

const runOnce = async (client) => {
    try {
        await processReminders(client);
        writeHeartbeat();
    } catch (error) {
        const errorCode = String(error && (error.code || error.name) || 'REMINDER_PROCESS_FAILED')
            .replace(/[^A-Za-z0-9_.:-]+/g, '_')
            .slice(0, 80) || 'REMINDER_PROCESS_FAILED';
        logger.error({ error_code: errorCode }, '[scheduler] Failed to process reminders');
    }
};

const scheduleReminderProcessing = (client) => {
    writeHeartbeat();
    cron.schedule('* * * * *', () => runOnce(client));
    logger.info('Cron job scheduled to run every minute.');
};

if (deliveryMode === 'rest') {
    const client = createDiscordRestDelivery({
        token,
        apiBaseUrl: process.env.DISCORD_API_BASE_URL,
    });
    logger.info('[scheduler] Using Discord REST delivery mode; Gateway login is disabled.');
    scheduleReminderProcessing(client);
} else {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', () => {
        logger.info(`Scheduler logged in as ${client.user.tag}`);
        scheduleReminderProcessing(client);
    });

    client.login(token).catch(err => {
        logger.error('Scheduler failed to log in:', err);
        process.exit(1);
    });
}
