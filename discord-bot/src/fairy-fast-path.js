"use strict";

const { randomUUID } = require("node:crypto");
const {
  buildFallbackFirstReplyMessage,
  normalizeFirstReplyForDiscord,
} = require("./fairy-first-reply-ai");

const FAIRY_COMMAND_NAME = "fairy";
const SLOW_PATH_TRIGGER_SOURCES = Object.freeze(["slash_command", "mention", "reply"]);

const DEFAULT_FAST_PATH_CAPS = Object.freeze({
  maxMessages: 20,
  maxLinks: 0,
  maxChars: 6000,
  collectionDeadlineMs: 1200,
});

const isValidTriggerSource = (value) => SLOW_PATH_TRIGGER_SOURCES.includes(value);

const validateTriggerSourcePair = (triggerSource, sourceMessageId) => {
  if (!isValidTriggerSource(triggerSource)) {
    throw new Error(`invalid trigger source: ${String(triggerSource)}`);
  }
  if (triggerSource === "slash_command" && sourceMessageId !== null) {
    throw new Error("invalid trigger/source pairing: slash_command requires source_message_id=null");
  }
  if (triggerSource !== "slash_command" && (typeof sourceMessageId !== "string" || sourceMessageId.length === 0)) {
    throw new Error(`invalid trigger/source pairing: ${triggerSource} requires non-empty source_message_id`);
  }
};

const sanitizeSummaryText = (value) =>
  String(value).replace(/[?？]/g, "").replace(/\s+/g, " ").trim();

const normalizeMessage = (value) => String(value).replace(/\s+/g, " ").trim();

const normalizeInvocationMessage = (raw) => {
  const normalized = sanitizeSummaryText(raw);
  return normalized || "依頼内容を確認して処理を開始する";
};

const readInvocationMessage = (interaction) => {
  const raw =
    interaction.options && typeof interaction.options.getString === "function"
      ? interaction.options.getString("request", false) || ""
      : "";
  return normalizeInvocationMessage(raw);
};

const readInvocationMessageFromMessage = (message) => {
  const botId = message && message.client && message.client.user ? String(message.client.user.id || "") : "";
  const raw = String((message && message.content) || "");
  if (!botId) return normalizeInvocationMessage(raw);
  const mentionTokenPattern = new RegExp(`<@!?${botId}>`, "g");
  const stripped = raw.replace(mentionTokenPattern, " ");
  return normalizeInvocationMessage(stripped);
};

const generateRequestId = (date = new Date(), randomSource = randomUUID) => {
  const yyyymmdd = [
    date.getUTCFullYear().toString(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
  const hhmmssmmm = [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
    String(date.getUTCMilliseconds()).padStart(3, "0"),
  ].join("");
  const entropy = randomSource().replace(/-/g, "").slice(0, 12).toLowerCase();
  return `RQ-${yyyymmdd}-${hhmmssmmm}-${entropy}`;
};

const buildFirstReplyMessage = (invocationMessage) => buildFallbackFirstReplyMessage(invocationMessage);

const collectFastPathContext = ({ recentMessages, caps, now = Date.now, startedAtMs = now() }) => {
  const source = recentMessages.slice(0, caps.maxMessages);
  const messages = [];
  let consideredMessages = 0;
  let usedMessages = 0;
  let totalChars = 0;
  let reachedDeadline = false;
  let truncated = false;

  for (const raw of source) {
    consideredMessages += 1;
    if (now() - startedAtMs > caps.collectionDeadlineMs) {
      reachedDeadline = true;
      break;
    }

    const plain = normalizeMessage(raw);
    if (!plain) continue;

    const remainingChars = caps.maxChars - totalChars;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    if (plain.length > remainingChars) {
      const chunk = plain.slice(0, remainingChars).trimEnd();
      if (chunk) {
        messages.push(chunk);
        usedMessages += 1;
        totalChars += chunk.length;
      }
      truncated = true;
      break;
    }

    messages.push(plain);
    usedMessages += 1;
    totalChars += plain.length;
  }

  return {
    messages,
    consideredMessages,
    usedMessages,
    totalChars,
    reachedDeadline,
    truncated,
  };
};

const normalizeWebhookPath = (webhookPath) => {
  if (!webhookPath) return "/webhook/fairy-slow-path";
  return webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`;
};

const isLocalHost = (hostname) => {
  const normalized = String(hostname).toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

const createSlowPathWebhookClient = ({
  n8nBase,
  webhookPath,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) => {
  if (!n8nBase) {
    throw new Error("Missing N8N_BASE");
  }
  const base = String(n8nBase).replace(/\/$/, "");
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "https:" && !isLocalHost(baseUrl.hostname)) {
    throw new Error("N8N_BASE must use https unless targeting localhost");
  }
  const endpoint = `${base}${normalizeWebhookPath(webhookPath)}`;

  return {
    enqueue: async (payload) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`slow-path webhook timed out: timeoutMs=${timeoutMs}`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch (_error) {
          body = "";
        }
        throw new Error(`slow-path webhook failed: status=${response.status} body=${body}`);
      }
      return { status: response.status };
    },
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const composeFirstReply = async ({ invocationMessage, contextMessages, firstReplyComposer }) => {
  const fallbackFirstReply = buildFirstReplyMessage(invocationMessage);
  if (typeof firstReplyComposer !== "function") {
    return {
      firstReplyMessage: fallbackFirstReply,
      firstReplySource: "fallback",
      firstReplyError: undefined,
    };
  }

  try {
    const generated = await firstReplyComposer({
      invocationMessage,
      contextExcerpt: contextMessages,
    });
    return {
      firstReplyMessage: normalizeFirstReplyForDiscord(generated, fallbackFirstReply),
      firstReplySource: "ai",
      firstReplyError: undefined,
    };
  } catch (error) {
    return {
      firstReplyMessage: fallbackFirstReply,
      firstReplySource: "fallback",
      firstReplyError: sanitizeSummaryText(String(error)).slice(0, 280),
    };
  }
};

const enqueueSlowPathWithRetry = async ({
  slowPathClient,
  payload,
  enqueueAttempts,
  enqueueRetryDelayMs,
}) => {
  let enqueueError;
  for (let attempt = 1; attempt <= enqueueAttempts; attempt += 1) {
    try {
      await slowPathClient.enqueue(payload);
      enqueueError = undefined;
      break;
    } catch (error) {
      enqueueError = String(error);
      if (attempt < enqueueAttempts) {
        await delay(enqueueRetryDelayMs);
      }
    }
  }
  return enqueueError;
};

const buildEnqueueFailureMessage = (firstReplyMessage, enqueueError) => {
  const detail = sanitizeSummaryText(enqueueError).slice(0, 140);
  return [
    firstReplyMessage,
    "",
    "後続処理の投入に失敗したため自動処理を開始できませんでした。",
    `詳細: ${detail || "n8n webhook enqueue failed"}`,
    "時間をおいて再実行してください。",
  ].join("\n");
};

const handleFairyInteraction = async (interaction, options) => {
  if (interaction.commandName !== FAIRY_COMMAND_NAME) {
    return { handled: false };
  }

  const now = options.now || Date.now;
  const startedAtMs = now();
  const triggerSource = options.triggerSource || "slash_command";
  const sourceMessageId = options.sourceMessageId === undefined ? null : options.sourceMessageId;
  validateTriggerSourcePair(triggerSource, sourceMessageId);
  await interaction.deferReply({ ephemeral: false });
  const deferLatencyMs = now() - startedAtMs;

  const invocationMessage = readInvocationMessage(interaction);
  const recentMessages = options.contextSource
    ? await options.contextSource(interaction)
    : [invocationMessage];
  const caps = options.caps || DEFAULT_FAST_PATH_CAPS;
  const context = collectFastPathContext({
    recentMessages,
    caps,
    now,
    startedAtMs,
  });

  const requestId =
    (options.requestIdFactory && options.requestIdFactory()) || generateRequestId(new Date());
  const { firstReplyMessage, firstReplySource, firstReplyError } = await composeFirstReply({
    invocationMessage,
    contextMessages: context.messages,
    firstReplyComposer: options.firstReplyComposer,
  });
  const firstReplyResult = await interaction.editReply({ content: firstReplyMessage });
  const firstReplyMessageId =
    firstReplyResult && typeof firstReplyResult === "object" && typeof firstReplyResult.id === "string"
      ? firstReplyResult.id
      : null;
  const firstReplyLatencyMs = now() - startedAtMs;

  const payload = {
    request_id: requestId,
    event_id: interaction.id,
    application_id: interaction.applicationId,
    trigger_source: triggerSource,
    source_message_id: sourceMessageId,
    user_id: interaction.user.id,
    channel_id: interaction.channelId,
    guild_id: interaction.guildId || null,
    command_name: FAIRY_COMMAND_NAME,
    invocation_message: invocationMessage,
    context_excerpt: context.messages,
    context_meta: {
      considered_messages: context.consideredMessages,
      used_messages: context.usedMessages,
      max_messages: caps.maxMessages,
      max_links: caps.maxLinks,
      max_chars: caps.maxChars,
      collection_deadline_ms: caps.collectionDeadlineMs,
      total_chars: context.totalChars,
      reached_deadline: context.reachedDeadline,
      truncated: context.truncated,
    },
    first_reply_message_id: firstReplyMessageId,
    created_at: new Date().toISOString(),
  };

  const enqueueAttempts = Math.max(1, Number(options.enqueueAttempts || 2));
  const enqueueRetryDelayMs = Math.max(0, Number(options.enqueueRetryDelayMs || 300));
  const enqueueError = await enqueueSlowPathWithRetry({
    slowPathClient: options.slowPathClient,
    payload,
    enqueueAttempts,
    enqueueRetryDelayMs,
  });

  if (enqueueError) {
    const failureMessage = buildEnqueueFailureMessage(firstReplyMessage, enqueueError);
    try {
      await interaction.editReply({ content: failureMessage });
    } catch (_error) {
      // keep initial message
    }
  }

  return {
    handled: true,
    requestId,
    deferLatencyMs,
    firstReplyLatencyMs,
    firstReplyMessage,
    firstReplySource,
    firstReplyError,
    payload,
    enqueueError,
  };
};

const handleFairyMessage = async (message, options) => {
  const now = options.now || Date.now;
  const startedAtMs = now();
  const triggerSource = options.messageTriggerSource || "mention";
  const sourceMessageId = options.sourceMessageId === undefined ? message.id : options.sourceMessageId;
  validateTriggerSourcePair(triggerSource, sourceMessageId);
  const invocationMessage = readInvocationMessageFromMessage(message);
  const recentMessages = options.contextSource ? await options.contextSource(message) : [invocationMessage];
  const caps = options.caps || DEFAULT_FAST_PATH_CAPS;
  const context = collectFastPathContext({
    recentMessages,
    caps,
    now,
    startedAtMs,
  });

  const requestId =
    (options.requestIdFactory && options.requestIdFactory()) || generateRequestId(new Date());
  const { firstReplyMessage, firstReplySource, firstReplyError } = await composeFirstReply({
    invocationMessage,
    contextMessages: context.messages,
    firstReplyComposer: options.firstReplyComposer,
  });

  const firstReplyResult = await message.reply({
    content: firstReplyMessage,
    allowedMentions: { repliedUser: false },
  });
  const firstReplyMessageId =
    firstReplyResult && typeof firstReplyResult === "object" && typeof firstReplyResult.id === "string"
      ? firstReplyResult.id
      : null;
  const firstReplyLatencyMs = now() - startedAtMs;

  const payload = {
    request_id: requestId,
    event_id: message.id,
    application_id:
      (message.client && message.client.application && message.client.application.id) ||
      (message.client && message.client.user && message.client.user.id) ||
      null,
    trigger_source: triggerSource,
    source_message_id: sourceMessageId,
    user_id: message.author.id,
    channel_id: message.channelId || (message.channel && message.channel.id) || null,
    guild_id: message.guildId || null,
    command_name: FAIRY_COMMAND_NAME,
    invocation_message: invocationMessage,
    context_excerpt: context.messages,
    context_meta: {
      considered_messages: context.consideredMessages,
      used_messages: context.usedMessages,
      max_messages: caps.maxMessages,
      max_links: caps.maxLinks,
      max_chars: caps.maxChars,
      collection_deadline_ms: caps.collectionDeadlineMs,
      total_chars: context.totalChars,
      reached_deadline: context.reachedDeadline,
      truncated: context.truncated,
    },
    first_reply_message_id: firstReplyMessageId,
    created_at:
      message.createdAt && typeof message.createdAt.toISOString === "function"
        ? message.createdAt.toISOString()
        : new Date().toISOString(),
  };

  const enqueueAttempts = Math.max(1, Number(options.enqueueAttempts || 2));
  const enqueueRetryDelayMs = Math.max(0, Number(options.enqueueRetryDelayMs || 300));
  const enqueueError = await enqueueSlowPathWithRetry({
    slowPathClient: options.slowPathClient,
    payload,
    enqueueAttempts,
    enqueueRetryDelayMs,
  });

  if (enqueueError) {
    const failureMessage = buildEnqueueFailureMessage(firstReplyMessage, enqueueError);
    try {
      if (firstReplyResult && typeof firstReplyResult.edit === "function") {
        await firstReplyResult.edit({ content: failureMessage });
      } else {
        await message.reply({
          content: failureMessage,
          allowedMentions: { repliedUser: false },
        });
      }
    } catch (_error) {
      // keep initial message
    }
  }

  return {
    handled: true,
    requestId,
    deferLatencyMs: null,
    firstReplyLatencyMs,
    firstReplyMessage,
    firstReplySource,
    firstReplyError,
    payload,
    enqueueError,
  };
};

const createFairyInteractionHandler = (options) => async (interaction) => {
  if (!interaction.isChatInputCommand || !interaction.isChatInputCommand()) {
    return { handled: false };
  }
  if (interaction.commandName !== FAIRY_COMMAND_NAME) {
    return { handled: false };
  }
  return handleFairyInteraction(interaction, options);
};

const createFairyMessageHandler = (options) => async (message, runtimeOptions = {}) => {
  if (!message || !message.content || !message.author || message.author.bot) {
    return { handled: false };
  }
  const triggerOptions = { ...options, ...runtimeOptions };
  return handleFairyMessage(message, triggerOptions);
};

module.exports = {
  FAIRY_COMMAND_NAME,
  DEFAULT_FAST_PATH_CAPS,
  generateRequestId,
  buildFirstReplyMessage,
  collectFastPathContext,
  createSlowPathWebhookClient,
  createFairyInteractionHandler,
  createFairyMessageHandler,
};
