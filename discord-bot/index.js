const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getBotToken } = require("./src/config");
const { getSheetsClient } = require('./src/google-sheets');
const { handleCommand, handleButton } = require('./src/command-handler');
const {
  FAIRY_COMMAND_NAME,
  createSlowPathWebhookClient,
  createFairyInteractionHandler,
  createFairyMessageHandler,
} = require("./src/fairy-fast-path");
const { resolveReplyAntecedentEntry } = require("./src/reply-antecedent");
const {
  collectRecentChannelContextEntries: collectDiscordContextEntries,
  resolveDiscordContextLimits,
} = require("./src/discord-context");
const { createPermanentMemorySyncServer } = require("./src/permanent-memory-sync-server");
const logger = require('./src/logger');
const { MESSAGES } = require('./src/message-templates');
const { createWebhookRequestBuilder } = require('./src/n8n-webhook');
const { parseImageGenerationConfig } = require("./src/image-generation-config");
const { createImageGenerationIntentDetector } = require("./src/image-generation-intent");
const { createImageGenerationService } = require("./src/image-generation-service");
const { createImageGenerationDiscordHandler, IMAGE_BUTTON_PREFIX } = require("./src/image-generation-discord-handler");

const token = getBotToken();
const webhookUrl = process.env.N8N_WEBHOOK_URL;
const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
const webhookRequest = createWebhookRequestBuilder({ webhookUrl, webhookSecret, logger });

const parsePositiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const parseBoolean = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseOptionalString = (raw, fallback = "") => {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === "" ? fallback : value;
};

const contentMentionsBot = (content, botUserId) => {
  if (!botUserId) return false;
  const mentionPattern = new RegExp(`<@!?${String(botUserId)}>`);
  return mentionPattern.test(String(content || ""));
};

const discordContextLimits = resolveDiscordContextLimits(process.env);

const collectRecentChannelContextResult = async (source) =>
  collectDiscordContextEntries(source, { limits: discordContextLimits });

const readInteractionContextContent = (interaction) =>
  String(
    interaction &&
      interaction.options &&
      typeof interaction.options.getString === "function"
      ? interaction.options.getString("request", false) || ""
      : ""
  ).trim();

const readMessageContextContent = (message) => {
  const botId = message && message.client && message.client.user ? String(message.client.user.id || "") : "";
  const raw = String((message && message.content) || "");
  if (!botId) return raw.trim();
  return raw.replace(new RegExp(`<@!?${botId}>`, "g"), " ").replace(/\s+/g, " ").trim();
};

const collectInteractionContextResult = (source) => {
  const interaction = source && source.interaction ? source.interaction : source;
  return collectRecentChannelContextResult({
    ...interaction,
    channel: interaction && interaction.channel,
    channelId: interaction && interaction.channelId,
    guildId: interaction && interaction.guildId,
    client,
    content: (source && source.content) || readInteractionContextContent(interaction),
    operationChannelId: (source && source.operationChannelId) || (interaction && interaction.channelId),
    allowedChannelIds: source && source.allowedChannelIds,
    allowedCategoryIds: source && source.allowedCategoryIds,
    channelRegistry: source && source.channelRegistry,
  });
};

const collectMessageContextResult = (source) => {
  const message = source && source.message ? source.message : source;
  return collectRecentChannelContextResult({
    ...message,
    channel: message && message.channel,
    channelId: message && message.channelId,
    guildId: message && message.guildId,
    client: (message && message.client) || client,
    content: (source && source.content) || readMessageContextContent(message),
    operationChannelId:
      (source && source.operationChannelId) ||
      (message && (message.channelId || (message.channel && message.channel.id))),
    allowedChannelIds: source && source.allowedChannelIds,
    allowedCategoryIds: source && source.allowedCategoryIds,
    channelRegistry: source && source.channelRegistry,
  });
};

const collectRecentChannelContext = async (interaction) => {
  const entries = await collectRecentChannelContextEntries(interaction);
  return entries.map((entry) => entry.content);
};

const collectRecentChannelContextEntries = async (interaction) => {
  const result = await collectRecentChannelContextResult(interaction);
  return result.entries;
};

let fairyInteractionHandler = null;
let fairyMessageHandler = null;
let permanentMemorySyncRuntime = null;
let imageGenerationHandler = null;
const fairyEnabled = parseBoolean(process.env.FAIRY_ENABLED, false);
const fairyMessageTriggerEnabled = parseBoolean(process.env.FAIRY_ENABLE_MESSAGE_TRIGGER, true);
if (fairyEnabled) {
  try {
    const slowPathClient = createSlowPathWebhookClient({
      n8nBase: process.env.N8N_BASE,
      webhookPath: process.env.N8N_SLOW_PATH_WEBHOOK_PATH,
      timeoutMs: parsePositiveInt(process.env.N8N_SLOW_PATH_TIMEOUT_MS, 8000),
    });
    let firstReplyComposer;
    if (process.env.OPENAI_API_KEY) {
      const { fairyCoreAdapter } = require("./src/fairy-core-adapter");
      firstReplyComposer = fairyCoreAdapter.createOpenAiFirstReplyComposer({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.FIRST_REPLY_AI_MODEL || "o4-mini",
        timeoutMs: parsePositiveInt(process.env.FIRST_REPLY_AI_TIMEOUT_MS, 5000),
        apiBase: process.env.OPENAI_BASE_URL || "https://api.openai.com",
      });
    }
    fairyInteractionHandler = createFairyInteractionHandler({
      slowPathClient,
      contextSource: (interaction) => collectRecentChannelContext(interaction),
      contextEntriesSource: collectInteractionContextResult,
      firstReplyComposer,
    });
    fairyMessageHandler = createFairyMessageHandler({
      slowPathClient,
      contextSource: (message) => collectRecentChannelContext(message),
      contextEntriesSource: collectMessageContextResult,
      firstReplyComposer,
    });
    logger.info("[fairy] response runtime enabled");
  } catch (error) {
    logger.warn({ err: error }, "[fairy] disabled due to invalid configuration");
  }
} else {
  logger.info("[fairy] response runtime disabled");
}

const imageGenerationConfig = parseImageGenerationConfig(process.env);
if (!imageGenerationConfig.enabled) {
  logger.info("[image-generation] runtime disabled by DOKOBASHO_IMAGE_ENABLED");
} else if (!imageGenerationConfig.webhookToken) {
  logger.warn("[image-generation] runtime disabled because DOKOBASHO_IMAGE_WEBHOOK_TOKEN is not configured");
} else {
try {
  let openAiImageIntentDetector = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const { createOpenAiImageIntentDetector } = require("./src/image-generation-openai-intent");
      openAiImageIntentDetector = createOpenAiImageIntentDetector({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.DOKOBASHO_IMAGE_INTENT_MODEL || process.env.IMAGE_GENERATION_INTENT_MODEL,
        apiBase: process.env.OPENAI_BASE_URL || "https://api.openai.com",
        timeoutMs: parsePositiveInt(process.env.DOKOBASHO_IMAGE_INTENT_TIMEOUT_MS, 5000),
      });
    } catch (error) {
      logger.warn({ err: error }, "[image-generation] OpenAI intent detector disabled; using deterministic fallback");
    }
  }
  const imageIntentDetector = createImageGenerationIntentDetector({
    detector: openAiImageIntentDetector,
    threshold: imageGenerationConfig.intentConfidenceThreshold,
  });
  const imageGenerationService = createImageGenerationService({
    config: imageGenerationConfig,
    intentDetector: imageIntentDetector,
  });
  imageGenerationHandler = createImageGenerationDiscordHandler({
    service: imageGenerationService,
    logger,
    confirmationTtlMs: imageGenerationConfig.confirmationTtlSeconds * 1000,
  });
  logger.info("[image-generation] runtime enabled");
} catch (error) {
  logger.warn({ err: error }, "[image-generation] runtime disabled due to invalid configuration");
}
}

const permanentMemorySyncEnabled = parseBoolean(process.env.PERMANENT_MEMORY_SYNC_ENABLED, true);
if (permanentMemorySyncEnabled) {
  try {
    const syncServer = createPermanentMemorySyncServer({
      token: parseOptionalString(process.env.PERMANENT_MEMORY_SYNC_TOKEN, ""),
      outputDir: parseOptionalString(process.env.PERMANENT_MEMORY_SYNC_DIR, "/opt/dokobasho/permanent-memory"),
      outputFile: parseOptionalString(process.env.PERMANENT_MEMORY_SYNC_FILE, "permanent-memory.md"),
      path: parseOptionalString(process.env.PERMANENT_MEMORY_SYNC_PATH, "/internal/permanent-memory/sync"),
      readPath: parseOptionalString(process.env.PERMANENT_MEMORY_READ_PATH, "/internal/permanent-memory/read"),
      port: parsePositiveInt(process.env.PERMANENT_MEMORY_SYNC_PORT, 8789),
      maxReadChars: parsePositiveInt(process.env.PERMANENT_MEMORY_READ_MAX_CHARS, 8000),
      host: parseOptionalString(process.env.PERMANENT_MEMORY_SYNC_HOST, "0.0.0.0"),
      logger,
    });
    permanentMemorySyncRuntime = syncServer;
  } catch (error) {
    logger.error({ err: error }, "[permanent-sync] failed to configure server");
  }
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
  if (!client.user || message.author.bot) {
    if (message.author.id === client.user?.id) rememberBotMessage(message.id);
    return;
  }

  if (imageGenerationHandler) {
    try {
      const imageResult = await imageGenerationHandler.handleMessage(message);
      if (imageResult && imageResult.handled) return;
    } catch (error) {
      logger.error({ err: error }, "[image-generation] message handler failed");
      return;
    }
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

  let isMentionToBot = false;
  try {
    isMentionToBot = Boolean(message.mentions?.users?.has(client.user.id));
  } catch (error) {
    logger.warn({ err: error, messageId: message.id }, "[fairy] mention metadata unavailable");
  }
  if (!isMentionToBot && contentMentionsBot(message.content, client.user.id)) {
    isMentionToBot = true;
    logger.info(
      `[fairy] trigger-context route=mention reason=raw_content_mention_fallback message_id=${message.id} channel_id=${message.channel?.id || message.channelId || ""}`
    );
  }
  if (!isMentionToBot && !isReplyToBot) return;
  if (!fairyEnabled) return;

  if (fairyMessageTriggerEnabled && fairyMessageHandler) {
    try {
      const triggerSource = isReplyToBot ? "reply" : "mention";
      let replyAntecedentEntry;
      if (message.reference?.messageId) {
        try {
          replyAntecedentEntry = await resolveReplyAntecedentEntry(message);
        } catch (error) {
          logger.warn({ err: error, messageId: message.id }, "[fairy] reply antecedent resolution failed");
          replyAntecedentEntry = undefined;
        }
      }
      const result = await fairyMessageHandler(message, {
        messageTriggerSource: triggerSource,
        sourceMessageId: message.id,
        replyAntecedentEntry,
      });
      if (result.handled) {
        if (result.replyMessageId) rememberBotMessage(result.replyMessageId);
        const conversation = result.payload && result.payload.context && result.payload.context.conversation;
        logger.info(
          {
            request_id: result.requestId,
            trigger_message_id: message.id,
            reply_message_id: result.replyMessageId || "",
            operation_channel_id: result.payload && result.payload.channel && result.payload.channel.id,
            thread_id: result.payload && result.payload.channel && result.payload.channel.thread_id,
            execution_mode: result.payload && result.payload.execution && result.payload.execution.mode,
            execution_reason: result.payload && result.payload.execution && result.payload.execution.reason,
            conversation_used_messages: conversation && conversation.used_messages,
            conversation_truncated: conversation && conversation.truncated,
            conversation_reason: conversation && conversation.reason,
            conversation_error_code: conversation && conversation.error_code,
            conversation_fetch_batches: conversation && conversation.fetch_batches,
            conversation_target_fetches: conversation && conversation.target_fetches,
            conversation_target_fetch_failures: conversation && conversation.target_fetch_failures,
            conversation_target_message_count: conversation && conversation.target_message_count,
            gate_reason: result.gate && result.gate.reason,
          },
          `[fairy] message-trigger handled`
        );
        if (result.firstReplySource === "fallback" && result.firstReplyError) {
          logger.warn(
            { requestId: result.requestId, error: result.firstReplyError },
            "[fairy] message-trigger first reply composer fallback"
          );
        }
        if (result.enqueueError) {
          logger.warn(
            { requestId: result.requestId, error: result.enqueueError },
            "[fairy] message-trigger enqueue failed"
          );
        }
        return;
      }
    } catch (error) {
      logger.error({ err: error }, "[fairy] message-trigger failed");
      return;
    }
  }

  if (!webhookUrl) return;
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
        if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === 'image') {
            if (imageGenerationHandler) {
                await imageGenerationHandler.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: MESSAGES.imageGeneration.errors.credential_error, ephemeral: true });
            }
        } else if (
            interaction.isButton &&
            interaction.isButton() &&
            String(interaction.customId || '').startsWith(`${IMAGE_BUTTON_PREFIX}:`)
        ) {
            if (imageGenerationHandler) {
                await imageGenerationHandler.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: MESSAGES.imageGeneration.errors.credential_error, ephemeral: true });
            }
        } else
        if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
            await handleCommand(interaction);
        } else if (interaction.isChatInputCommand() && interaction.commandName === FAIRY_COMMAND_NAME) {
            if (!fairyEnabled) {
                await interaction.reply({ content: MESSAGES.errors.fairyDisabled, ephemeral: true });
                return;
            }
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

if (permanentMemorySyncRuntime) {
  permanentMemorySyncRuntime.start().catch((error) => {
    logger.error({ err: error }, "[permanent-sync] failed to start server");
    process.exit(1);
  });
}

const shutdown = async (signal) => {
  logger.info({ signal }, "[shutdown] received signal");
  if (permanentMemorySyncRuntime) {
    try {
      await permanentMemorySyncRuntime.stop();
    } catch (error) {
      logger.error({ err: error }, "[permanent-sync] failed to stop server");
    }
  }
  try {
    await client.destroy();
  } catch (error) {
    logger.error({ err: error }, "[shutdown] failed to destroy discord client");
  }
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("unhandledRejection", (error) => {
  logger.error("[unhandledRejection]", error);
});

process.on("uncaughtException", (error) => {
  logger.error("[uncaughtException]", error);
});
