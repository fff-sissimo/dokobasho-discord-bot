const path = require('path');
const logger = require('./src/logger');

function validateCommands(commands) {
  const hasDeprecatedGet = commands.some((command) =>
    command.name === 'remind' &&
    Array.isArray(command.options) &&
    command.options.some((option) => option.name === 'get')
  );
  if (hasDeprecatedGet) throw new Error('The /remind get subcommand is deprecated and must not be deployed.');
}

async function deployCommands({ rest, route, commands, log = logger }) {
  validateCommands(commands);
  log.info(`Started refreshing ${commands.length} application (/) commands.`);
  const data = await rest.put(route, { body: commands });
  log.info(`Successfully reloaded ${data.length} application (/) commands.`);
  return data;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const { REST, Routes } = require('discord.js');
  const commands = require('./src/commands');
  const { getBotToken } = require('./src/config');
  const { CLIENT_ID, GUILD_ID } = process.env;
  const botToken = getBotToken();
  if (!botToken || !CLIENT_ID || !GUILD_ID) {
    throw new Error('BOT_TOKEN (or DISCORD_BOT_TOKEN), CLIENT_ID, and GUILD_ID are required.');
  }
  const rest = new REST({ version: '10' }).setToken(botToken);
  return deployCommands({
    rest,
    route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    commands,
  });
}

async function runMain({ mainImpl = main, processRef = process, log = logger } = {}) {
  try {
    return await mainImpl();
  } catch (error) {
    log.error({ err: error }, 'Failed to deploy commands');
    processRef.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  void runMain();
}

module.exports = { deployCommands, main, runMain, validateCommands };
