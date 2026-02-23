const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getBotToken } = require("./src/config");
const { getSheetsClient } = require('./src/google-sheets');
const { handleCommand, handleButton } = require('./src/command-handler');
const {
  FAIRY_COMMAND_NAME,
  DEFAULT_FAST_PATH_CAPS,
  createSlowPathWebhookClient,
  createFairyInteractionHandler,
} = require("./src/fairy-fast-path");
const { createOpenAiFirstReplyComposer } = require("./src/fairy-first-reply-ai");
const logger = require('./src/logger');
const { MESSAGES } = require('./src/message-templates');
const { createWebhookRequestBuilder } = require('./src/n8n-webhook');

const token = getBotToken();
const webhookUrl = process.env.N8N_WEBHOOK_URL;
const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
const webhookRequest = createWebhookRequestBuilder({ webhookUrl, webhookSecret, logger });

const parsePositiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const collectRecentChannelContext = async (
  interaction,
  limit = DEFAULT_FAST_PATH_CAPS.maxMessages
) => {
  const channel = interaction.channel;
  if (!channel || !channel.messages || typeof channel.messages.fetch !== "function") {
    return [];
  }

  try {
    const fetched = await channel.messages.fetch({ limit });
    const ordered = Array.from(fetched.values()).sort(
      (a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0)
    );
    return ordered
      .map((message) => (typeof message.content === "string" ? message.content.trim() : ""))
      .filter((content) => content.length > 0);
  } catch (_error) {
    return [];
  }
};

let fairyInteractionHandler = null;
try {
  const slowPathClient = createSlowPathWebhookClient({
    n8nBase: process.env.N8N_BASE,
    webhookPath: process.env.N8N_SLOW_PATH_WEBHOOK_PATH,
    timeoutMs: parsePositiveInt(process.env.N8N_SLOW_PATH_TIMEOUT_MS, 8000),
  });
  const firstReplyComposer = process.env.OPENAI_API_KEY
    ? createOpenAiFirstReplyComposer({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.FIRST_REPLY_AI_MODEL || "o4-mini",
        timeoutMs: parsePositiveInt(process.env.FIRST_REPLY_AI_TIMEOUT_MS, 2500),
        apiBase: process.env.OPENAI_BASE_URL || "https://api.openai.com",
      })
    : undefined;
  fairyInteractionHandler = createFairyInteractionHandler({
    slowPathClient,
    contextSource: (interaction) => collectRecentChannelContext(interaction),
    firstReplyComposer,
  });
} catch (error) {
  logger.warn({ err: error }, "[fairy] disabled due to invalid configuration");
}

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
  if (!webhookRequest.shouldSend()) return;

  const payload = { discord_user_id: message.author.id, discord_username: message.author.username, channel_id: message.channel?.id, guild_id: message.guild?.id, message_id: message.id, content: message.content, created_at: message.createdAt.toISOString() };

  try {
    const headers = webhookRequest.buildHeaders();
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok)     logger.warn(`[webhook] Non-2xx response: ${response.status}`);
  } catch (error) {     logger.error("[webhook] Request failed", error); }
});

// --- Main Interaction Handler ---
client.on(Events.InteractionCreate, async (interaction) => {
    const handleError = async (error, int) => {
        logger.error('[InteractionCreate] Error:', error);
        const commandName = int && int.isChatInputCommand && int.isChatInputCommand() ? int.commandName : undefined;
        const message = commandName === FAIRY_COMMAND_NAME
            ? MESSAGES.errors.generic
            : error.message.includes('GOOGLE_SA_KEY_JSON')
                ? MESSAGES.errors.reminderNotConfigured
                : MESSAGES.errors.generic;
        
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
        } else if (interaction.isChatInputCommand() && interaction.commandName === FAIRY_COMMAND_NAME) {
            if (!fairyInteractionHandler) {
                await interaction.reply({ content: MESSAGES.errors.fairyNotConfigured, ephemeral: true });
                return;
            }
            const result = await fairyInteractionHandler(interaction);
            if (result.handled) {
                logger.info(
                  `[fairy] handled request_id=${result.requestId} defer=${result.deferLatencyMs}ms firstReply=${result.firstReplyLatencyMs}ms source=${result.firstReplySource || "fallback"}`
                );
                if (result.firstReplySource === "fallback" && result.firstReplyError) {
                    logger.warn(
                      { requestId: result.requestId, error: result.firstReplyError },
                      "[fairy] first reply composer fallback"
                    );
                }
                if (result.enqueueError) {
                    logger.warn({ requestId: result.requestId, error: result.enqueueError }, "[fairy] enqueue failed");
                }
            }
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
