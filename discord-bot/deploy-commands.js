const path = require('path');
const logger = require('./src/logger'); // Add logger
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { REST, Routes } = require('discord.js');
const commands = require('./src/commands');
const { getBotToken } = require('./src/config');


const { CLIENT_ID, GUILD_ID } = process.env;
const botToken = getBotToken();

if (!botToken || !CLIENT_ID || !GUILD_ID) {
    logger.error('Error: BOT_TOKEN (or DISCORD_BOT_TOKEN), CLIENT_ID, and GUILD_ID must be provided in the .env file.');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(botToken);

(async () => {
    try {
        logger.info(`Started refreshing ${commands.length} application (/) commands for guild ${GUILD_ID}.`);

        // For development, we deploy guild-specific commands for instant updates.
        const data = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands },
        );

        logger.info(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        logger.error('Failed to deploy commands:');
        logger.error(error);
    }
})();
