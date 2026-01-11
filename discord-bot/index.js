const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getSheetsClient } = require('./src/google-sheets');
const { handleCommand, handleButton } = require('./src/command-handler');
const logger = require('./src/logger');

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    logger.error(`[config] Missing ${name}`);
    process.exit(1);
  }
  return value;
};

const token = requireEnv("BOT_TOKEN");
const webhookUrl = process.env.N8N_WEBHOOK_URL;

// --- Cache (for n8n logic) ---
const BOT_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BOT_MESSAGE_CACHE_MAX = 1000;
const botMessageCache = new Map();
const pruneBotMessageCache = (now) => {
  for (const [messageId, timestamp] of botMessageCache) {
    if (now - timestamp > BOT_MESSAGE_CACHE_TTL_MS) botMessageCache.delete(messageId);
  }
  if (botMessageCache.size > BOT_MESSAGE_CACHE_MAX) {
    const entries = Array.from(botMessageCache.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length - BOT_MESSAGE_CACHE_MAX; i++) botMessageCache.delete(entries[i][0]);
  }
};
const rememberBotMessage = (messageId) => {
  const now = Date.now();
  botMessageCache.set(messageId, now);
  pruneBotMessageCache(now);
};
const isRecentBotMessage = (messageId) => {
  const timestamp = botMessageCache.get(messageId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > BOT_MESSAGE_CACHE_TTL_MS) {
    botMessageCache.delete(messageId);
    return false;
  }
  return true;
};
// --- End Cache ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  logger.info(`[clientReady] Logged in as ${c.user.tag}`);
  getSheetsClient().catch(err => {
    logger.error('[Startup] Failed to initialize Google Sheets Client. Reminders will not work.', err);
  });
});

// --- n8n Webhook Handler ---
client.on("messageCreate", async (message) => {
  if (!webhookUrl || !client.user || message.author.bot) {
    if (message.author.id === client.user?.id) rememberBotMessage(message.id);
    return;
  }
  
  let isReplyToBot = message.mentions.repliedUser?.id === client.user.id;
  const referenceId = message.reference?.messageId;
  if (!isReplyToBot && referenceId && isRecentBotMessage(referenceId)) isReplyToBot = true;
  
  if (!isReplyToBot && referenceId) {
    try {
      const refMsg = await message.fetchReference();
      if (refMsg.author?.id === client.user.id) {
        isReplyToBot = true;
        rememberBotMessage(refMsg.id);
      }
    } catch (error) {    logger.warn("[reply] Failed to fetch referenced message", error); }
  }

  if (!message.mentions.users.has(client.user.id) && !isReplyToBot) return;

  const payload = { discord_user_id: message.author.id, discord_username: message.author.username, channel_id: message.channel?.id, guild_id: message.guild?.id, message_id: message.id, content: message.content, created_at: message.createdAt.toISOString() };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)     logger.warn(`[webhook] Non-2xx response: ${response.status}`);
  } catch (error) {     logger.error("[webhook] Request failed", error); }
});

// --- Main Interaction Handler ---
client.on(Events.InteractionCreate, async (interaction) => {
    const handleError = async (error, int) => {
        logger.error('[InteractionCreate] Error:', error);
        const message = error.message.includes('GOOGLE_SA_KEY_JSON')
            ? 'リマインダー機能は現在設定されていません。'
            : 'エラーが発生しました。詳細はログを確認してください。';
        
        const replyPayload = { content: message, components: [], ephemeral: true };
        try {
            if (int.deferred || int.replied) {
                await int.editReply(replyPayload);
            } else {
                await int.reply(replyPayload);
            }
        } catch (e) {
            logger.error('Failed to send error reply:', e);
        }
    };

    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
            await handleCommand(interaction);
        } else if (interaction.isButton() && interaction.customId.startsWith('delete-confirm_')) {
            await handleButton(interaction);
        }
    } catch (error) {
        await handleError(error, interaction);
    }
});


client.login(token).catch((error) => {
  logger.error("[login] Failed to login", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logger.error("[unhandledRejection]", error);
});

process.on("uncaughtException", (error) => {
  logger.error("[uncaughtException]", error);
});