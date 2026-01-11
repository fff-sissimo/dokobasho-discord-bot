const logger = require('./src/logger');
require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');
const { getPendingReminders, updateReminder } = require('./src/google-sheets');
const { calculateNextDate } = require('./src/utils');
const { processReminders } = require('./src/reminder-processor');
const { getBotToken } = require('./src/config');

logger.info('Scheduler process started.');

const token = getBotToken();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });






client.once('ready', () => {
    logger.info(`Scheduler logged in as ${client.user.tag}`);
    // Schedule the task to run every minute.
    cron.schedule('* * * * *', () => processReminders(client));
    logger.info('Cron job scheduled to run every minute.');
});

client.login(token).catch(err => {
    logger.error('Scheduler failed to log in:', err);
    process.exit(1);
});
