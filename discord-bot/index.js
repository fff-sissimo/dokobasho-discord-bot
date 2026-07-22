const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } = require("discord.js");
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
const vcMemo = require("./src/vc-memo");
const { editReply, ephemeralDefer } = require("./src/interaction-replies");

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

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const contentMentionsBot = (content, botUserId) => {
  if (!botUserId) return false;
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`);
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
  return raw.replace(new RegExp(`<@!?${escapeRegExp(botId)}>`, "g"), " ").replace(/\s+/g, " ").trim();
};

const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;

const truncateText = (value, maxLength, marker = "\n...") => {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= marker.length) return text.substring(0, maxLength);
  return `${text.substring(0, maxLength - marker.length)}${marker}`;
};

const buildVcMemoStopReplyContent = (result) => {
  const draft = String((result && result.draft) || "");
  const fullContent = `${MESSAGES.commands.vcMemo.responses.stopped}\n\n\`\`\`\n${draft}\n\`\`\``;
  if (fullContent.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
    return fullContent;
  }

  const sessionLine = result && result.sessionId ? `\nセッション: ${result.sessionId}` : "";
  let prefix = `${MESSAGES.commands.vcMemo.responses.stopped}\n\n全文は保存済みです。Discordではプレビューのみ表示します。${sessionLine}\n\n\`\`\`\n`;
  const suffix = "\n```\n(プレビューはDiscordの文字数制限に合わせて省略しています)";
  let previewLength = DISCORD_MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length;

  if (previewLength < 0 && sessionLine) {
    prefix = `${MESSAGES.commands.vcMemo.responses.stopped}\n\n全文は保存済みです。Discordではプレビューのみ表示します。\n\n\`\`\`\n`;
    previewLength = DISCORD_MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length;
  }

  const preview = truncateText(draft, previewLength);
  return `${prefix}${preview}${suffix}`;
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
      allowInsecureLoopback: parseBoolean(process.env.INTERNAL_API_ALLOW_INSECURE_LOOPBACK, false),
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

const clientIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
];
if (parseBoolean(process.env.DISCORD_MESSAGE_CONTENT_INTENT_ENABLED, true)) {
  clientIntents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents: clientIntents,
});

client.once(Events.ClientReady, (c) => {
  logger.info(`[clientReady] Logged in as ${c.user.tag}`);
  getSheetsClient().catch(err => {
    logger.error('[Startup] Failed to initialize Google Sheets Client. Reminders will not work.', err);
  });
  const vcMemoEnabled = parseBoolean(process.env.VC_MEMO_ENABLED, false);
  if (vcMemoEnabled) {
    logger.info('[vc-memo] runtime enabled');
  } else {
    logger.info('[vc-memo] runtime disabled');
  }
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
        logger.error({ err: error }, '[InteractionCreate] Error');
        const commandName = int && int.isChatInputCommand && int.isChatInputCommand() ? int.commandName : undefined;
        const message = commandName === FAIRY_COMMAND_NAME
            ? MESSAGES.errors.generic
            : error.message.includes('GOOGLE_SA_KEY_JSON')
                ? MESSAGES.errors.reminderNotConfigured
                : MESSAGES.errors.generic;
        
        const replyPayload = { content: message, components: [], flags: [MessageFlags.Ephemeral] };
        try {
            if (int.deferred || int.replied) {
                await int.editReply(editReply(message, { components: [] }));
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
                await interaction.reply({ content: MESSAGES.imageGeneration.errors.credential_error, flags: [MessageFlags.Ephemeral] });
            }
        } else if (
            interaction.isButton &&
            interaction.isButton() &&
            String(interaction.customId || '').startsWith(`${IMAGE_BUTTON_PREFIX}:`)
        ) {
            if (imageGenerationHandler) {
                await imageGenerationHandler.handleInteraction(interaction);
            } else {
                await interaction.reply({ content: MESSAGES.imageGeneration.errors.credential_error, flags: [MessageFlags.Ephemeral] });
            }
        } else
        if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
            await handleCommand(interaction);
        } else if (interaction.isChatInputCommand() && interaction.commandName === FAIRY_COMMAND_NAME) {
            if (!fairyEnabled) {
                await interaction.reply({ content: MESSAGES.errors.fairyDisabled, flags: [MessageFlags.Ephemeral] });
                return;
            }
            if (!fairyInteractionHandler) {
                await interaction.reply({ content: MESSAGES.errors.fairyNotConfigured, flags: [MessageFlags.Ephemeral] });
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
        } else if (interaction.isChatInputCommand() && interaction.commandName === 'vc-memo') {
            if (!vcMemo.checkFeatureEnabled()) {
                await interaction.reply({ content: MESSAGES.commands.vcMemo.errors.disabled, flags: [MessageFlags.Ephemeral] });
                return;
            }
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guild?.id || interaction.options.getString('guild_id');
            const controller = {
                userId: interaction.user?.id,
                canManageGuild: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
            };
            if (subcommand === 'start') {
                await interaction.deferReply(ephemeralDefer());
                const consentConfirmed = interaction.options.getBoolean('consent', true);
                const requestedChannelId = interaction.options.getString('channel_id');
                const memberVoiceChannelId = interaction.member?.voice?.channel?.id;
                const channelId = requestedChannelId || memberVoiceChannelId;
                if (!guildId) {
                    await interaction.editReply(editReply('DMでは実行できません。サーバーでコマンドを実行してください。'));
                    return;
                }
                if (!channelId) {
                    await interaction.editReply(editReply('参加中のボイスチャンネルが見つかりません。VCに参加してから実行するか、channel_id を指定してください。'));
                    return;
                }
                if (!memberVoiceChannelId || memberVoiceChannelId !== channelId) {
                    await interaction.editReply(editReply('録音対象のボイスチャンネルに参加してから実行してください。'));
                    return;
                }
                if (!controller.canManageGuild) {
                    await interaction.editReply(editReply('VC Memoの開始にはサーバー管理権限が必要です。'));
                    return;
                }
                const result = await vcMemo.start(client, {
                    guildId,
                    channelId,
                    ownerUserId: interaction.user?.id,
                    consentConfirmed,
                    canManageGuild: controller.canManageGuild,
                });
                logger.info({
                    guildId,
                    channelId,
                    guild: interaction.guild?.name,
                    memberVoiceChannel: interaction.member?.voice?.channel?.id,
                    memberVoiceChannelName: interaction.member?.voice?.channel?.name,
                }, '[vc-memo] start command options');
                if (result.error) {
                    const errorMessages = {
                        'A session is already active': 'すでにVC Memoセッションがアクティブです。',
                        'Another session is already active in this guild': 'このサーバーでは、すでにVC Memoセッションがアクティブです。',
                        'Recording consent is required': '録音を開始するには、参加者全員の同意確認が必要です。',
                        'Feature is disabled': 'VC Memo機能が無効化されています。',
                        'Guild' : 'このサーバーはVC Memoの対象外です。',
                        'Channel' : 'このチャンネルはVC Memoの対象外です。',
                    };
                    const detail = result.error;
                    let userMessage;
                    for (const [key, msg] of Object.entries(errorMessages)) {
                        if (detail.includes(key)) {
                            userMessage = msg;
                            break;
                        }
                    }
                    if (!userMessage) {
                        userMessage = `エラーが発生しました: ${detail}`;
                    }
                    await interaction.editReply(editReply(`❌ ${userMessage}`));
                } else {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.responses.started));
                }
            } else if (subcommand === 'stop') {
                await interaction.deferReply(ephemeralDefer());
                const activeSession = vcMemo.getActiveSession ? vcMemo.getActiveSession(guildId) : null;
                if (!activeSession) {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.errors.noSession));
                    return;
                }
                try {
                    const result = await vcMemo.stop(activeSession, controller);
                    if (result.error) {
                        await interaction.editReply(editReply(`❌ ${result.error}`));
                    } else {
                        await interaction.editReply(editReply(buildVcMemoStopReplyContent(result)));
                    }
                } catch (err) {
                    logger.error({ err }, '[vc-memo] stop failed');
                    await interaction.editReply(editReply(`❌ ${MESSAGES.commands.vcMemo.errors.processingError}`));
                }
            } else if (subcommand === 'status') {
                await interaction.deferReply(ephemeralDefer());
                const sessionId = interaction.options.getString('session_id') ||
                    (vcMemo.getCurrentSession ? vcMemo.getCurrentSession(guildId) : (vcMemo.getActiveSession ? vcMemo.getActiveSession(guildId) : null));
                if (!sessionId) {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.errors.noSession));
                    return;
                }
                const result = vcMemo.getStatus(sessionId);
                if (result.error) {
                    await interaction.editReply(editReply(`❌ ${result.error}`));
                } else {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.responses.status(result.sessionId, result.state)));
                }
            } else if (subcommand === 'discard') {
                await interaction.deferReply(ephemeralDefer());
                const sessionId = vcMemo.getCurrentSession ? vcMemo.getCurrentSession(guildId) : (vcMemo.getActiveSession ? vcMemo.getActiveSession(guildId) : null);
                if (!sessionId) {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.errors.noSession));
                    return;
                }
                const result = vcMemo.discard(sessionId, controller);
                if (result.error) {
                    await interaction.editReply(editReply(`❌ ${result.error}`));
                } else {
                    await interaction.editReply(editReply(MESSAGES.commands.vcMemo.responses.discarded));
                }
            }
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

const processHandlerRegistryKey = Symbol.for("dokobasho.discordBot.processHandlers");
const registerProcessHandler = (eventName, handler) => {
  const registry = globalThis[processHandlerRegistryKey] || new Map();
  const previousHandler = registry.get(eventName);
  if (previousHandler) {
    process.off(eventName, previousHandler);
  }
  process.on(eventName, handler);
  registry.set(eventName, handler);
  globalThis[processHandlerRegistryKey] = registry;
};

registerProcessHandler("SIGTERM", () => {
  void shutdown("SIGTERM");
});

registerProcessHandler("SIGINT", () => {
  void shutdown("SIGINT");
});

registerProcessHandler("unhandledRejection", (error) => {
  logger.error("[unhandledRejection]", error);
});

registerProcessHandler("uncaughtException", (error) => {
  logger.error("[uncaughtException]", error);
});
