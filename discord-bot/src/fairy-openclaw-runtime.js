"use strict";

const { randomUUID } = require("node:crypto");

const DEFAULT_OPENCLAW_TIMEOUT_MS = 85000;
const VALID_RUNTIME_MODES = new Set(["n8n", "openclaw"]);
const POSTABLE_ACTIONS = new Set(["reply", "offer", "assist"]);
const NON_POSTING_ACTIONS = new Set(["observe", "draft", "publish_blocked"]);
const SAFE_ALLOWED_MENTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false,
});
const TYPING_KEEPALIVE_INTERVAL_MS = 7500;
const DEFAULT_CHANNEL_REGISTRY = Object.freeze({
  "1094907178671939654": Object.freeze({ name: "妖精さんより", type: "sandbox" }),
  "840827137451229210": Object.freeze({ name: "はじまりの酒場", type: "chat" }),
  "841686630271418429": Object.freeze({ name: "らくがきちょう", type: "creation" }),
  "1465296404455882860": Object.freeze({ name: "vostok-vol02-general", type: "project" }),
  "1465295987236143319": Object.freeze({ name: "vostok-vol02-pd", type: "project" }),
  "1465296093427531960": Object.freeze({ name: "vostok-vol02-music", type: "project" }),
  "1465296285341847765": Object.freeze({ name: "vostok-vol02-artwork", type: "project" }),
  "1466404431217164288": Object.freeze({ name: "vostok-vol02-qa", type: "project" }),
  "840827137451229208": Object.freeze({ name: "更新・進行状況", type: "ops" }),
  "852073750294822922": Object.freeze({ name: "管理用", type: "ops" }),
});

const normalizeRuntimeMode = (raw) => {
  const value = String(raw || "n8n").trim().toLowerCase();
  return VALID_RUNTIME_MODES.has(value) ? value : "n8n";
};

const parsePositiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const parseAllowedChannelIds = (raw) =>
  String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const createOpenClawRuntimeConfig = (env = process.env) => {
  const mode = normalizeRuntimeMode(env.FAIRY_RUNTIME_MODE);
  if (mode !== "openclaw") {
    return { mode };
  }

  const apiUrl = String(env.OPENCLAW_API_URL || "").trim();
  const apiKey = String(env.OPENCLAW_API_KEY || "").trim();
  const guildId = String(env.GUILD_ID || env.DISCORD_GUILD_ID || "").trim();
  const allowedChannelIds = parseAllowedChannelIds(env.FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS);
  const missing = [];
  if (!apiUrl) missing.push("OPENCLAW_API_URL");
  if (!apiKey) missing.push("OPENCLAW_API_KEY");
  if (!guildId) missing.push("GUILD_ID");
  if (allowedChannelIds.length === 0) missing.push("FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS");
  if (missing.length > 0) {
    throw new Error(`missing OpenClaw runtime config: ${missing.join(", ")}`);
  }

  return {
    mode,
    apiUrl,
    apiKey,
    guildId,
    allowedChannelIds,
    timeoutMs: parsePositiveInt(env.OPENCLAW_API_TIMEOUT_MS, DEFAULT_OPENCLAW_TIMEOUT_MS),
  };
};

const createOpenClawClient = ({
  apiUrl,
  apiKey,
  timeoutMs = DEFAULT_OPENCLAW_TIMEOUT_MS,
  fetchImpl = fetch,
}) => {
  if (!apiUrl) throw new Error("missing OpenClaw apiUrl");
  if (!apiKey) throw new Error("missing OpenClaw apiKey");
  return {
    execute: async (payload) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`OpenClaw request timed out: timeoutMs=${timeoutMs}`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new Error(`OpenClaw request failed: status=${response.status}`);
      }
      return response.json();
    },
  };
};

const startTypingKeepalive = ({ channel, logger, intervalMs = TYPING_KEEPALIVE_INTERVAL_MS }) => {
  if (!channel || typeof channel.sendTyping !== "function") {
    return () => {};
  }

  let stopped = false;
  let loggedFailure = false;
  const sendTyping = async () => {
    try {
      await channel.sendTyping();
    } catch (error) {
      if (!loggedFailure && logger && typeof logger.warn === "function") {
        loggedFailure = true;
        logger.warn({ err: error }, "[fairy-openclaw] failed to send typing indicator");
      }
    }
  };

  void sendTyping();
  const interval = setInterval(() => {
    if (!stopped) void sendTyping();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
};

const normalizeMessageContent = (value) => String(value || "").replace(/\s+/g, " ").trim();

const normalizeIsoTimestamp = (value) => {
  if (value && typeof value.toISOString === "function") return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return "";
};

const stripBotMention = (content, botId) => {
  if (!botId) return normalizeMessageContent(content);
  const mentionTokenPattern = new RegExp(`<@!?${botId}>`, "g");
  return normalizeMessageContent(String(content || "").replace(mentionTokenPattern, " "));
};

const collectLinks = (content) => {
  const matches = String(content || "").match(/https?:\/\/\S+/g);
  return matches ? matches.slice(0, 10) : [];
};

const normalizeRoleMentions = (mentions) => {
  if (!mentions || !mentions.roles) return [];
  const roles = mentions.roles;
  if (typeof roles.map === "function") {
    return roles.map((role) => String(role && role.id ? role.id : role)).filter(Boolean);
  }
  if (roles.cache && typeof roles.cache.map === "function") {
    return roles.cache.map((role) => String(role.id)).filter(Boolean);
  }
  return [];
};

const normalizeAttachments = (attachments) => {
  if (!attachments) return [];
  const values =
    typeof attachments.values === "function"
      ? Array.from(attachments.values())
      : Array.isArray(attachments)
        ? attachments
        : [];
  return values
    .map((attachment) => ({
      id: String(attachment && attachment.id ? attachment.id : "").trim(),
      name: String(attachment && attachment.name ? attachment.name : "").trim(),
      content_type: String(attachment && attachment.contentType ? attachment.contentType : "").trim(),
      size: Number.isFinite(attachment && attachment.size) ? attachment.size : null,
    }))
    .filter((attachment) => attachment.id || attachment.name);
};

const normalizeContextEntries = (entries) => {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      message_id: String(entry.message_id || "").trim(),
      author_id: String(entry.author_user_id || entry.author_id || "").trim(),
      author_is_bot: Boolean(entry.author_is_bot),
      content: normalizeMessageContent(entry.content),
      created_at: normalizeIsoTimestamp(entry.created_at || entry.createdAt || entry.createdTimestamp),
    }))
    .filter((entry) => entry.message_id && entry.author_id && entry.content && entry.author_is_bot === false)
    .map((entry) => ({
      message_id: entry.message_id,
      author_id: entry.author_id,
      content: entry.content,
      created_at: entry.created_at,
    }));
};

const calculateActiveThreadAgeMinutes = ({ recentMessages, currentMessageId, currentCreatedAt }) => {
  const currentMs = Date.parse(currentCreatedAt);
  if (!Number.isFinite(currentMs)) return null;

  const previousMs = recentMessages.reduce((latestMs, entry) => {
    if (!entry || entry.message_id === currentMessageId || !entry.created_at) return latestMs;
    const candidateMs = Date.parse(entry.created_at);
    if (!Number.isFinite(candidateMs) || candidateMs > currentMs) return latestMs;
    return latestMs === null || candidateMs > latestMs ? candidateMs : latestMs;
  }, null);
  if (previousMs === null) return null;

  const diffMinutes = Math.floor((currentMs - previousMs) / 60000);
  return diffMinutes >= 0 ? diffMinutes : null;
};

const hasExplicitFollowupRequest = (content) => {
  const text = normalizeMessageContent(content);
  if (!text) return false;
  const negatedFollowup = /(?:約束|確認予定|予定|リマインド|フォローアップ|followup).{0,16}(?:しない|しなく|不要|いらない)|(?:しない|しなく|不要|いらない).{0,16}(?:約束|確認予定|予定|リマインド|フォローアップ|followup)/i;
  if (negatedFollowup.test(text)) return false;

  const timeCue = /(?:明日|あした|あす|明後日|今日|今夜|あとで|後で|後ほど|のちほど|来週|来月|\d{1,2}\s*[:：時]\s*\d{0,2}|[０-９]{1,2}\s*[：時]\s*[０-９]{0,2})/i;
  const followupVerb = /(?:確認して|確認したい|声(?:を)?かけて|思い出(?:したい|させて|して)|リマインド|remind|通知して|教えて|覚えておいて)/i;
  return timeCue.test(text) && followupVerb.test(text);
};

const resolveChannel = ({ channel, channelId, allowedChannelIds, channelRegistry = DEFAULT_CHANNEL_REGISTRY }) => {
  const id = String(channelId || (channel && channel.id) || "").trim();
  const registeredChannel = channelRegistry[id] || null;
  const registered = Boolean(registeredChannel);
  const verified = allowedChannelIds.has(id);
  return {
    id,
    name: String((channel && channel.name) || (registeredChannel && registeredChannel.name) || "").trim(),
    type: registered && verified ? registeredChannel.type : "unknown",
    registered: registered && verified,
  };
};

const isoNow = () => new Date().toISOString();

const buildOpenClawPayload = ({
  eventType,
  guildId,
  channel,
  message,
  content,
  isReplyToBot = false,
  mentionsBot = false,
  allowedChannelIds,
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
  contextEntries = [],
}) => {
  const now = isoNow();
  const messageId = String((message && message.id) || "").trim();
  const normalizedContent = normalizeMessageContent(content);
  const messageCreatedAt =
    normalizeIsoTimestamp(message && message.createdAt) ||
    normalizeIsoTimestamp(message && message.createdTimestamp) ||
    now;
  const recentMessages = normalizeContextEntries(contextEntries);

  return {
    schema_version: 1,
    source: "discord",
    event_type: eventType,
    received_at: now,
    guild_id: String(guildId || "").trim(),
    channel: resolveChannel({
      channel: message && message.channel,
      channelId: channel && channel.id,
      allowedChannelIds,
      channelRegistry,
    }),
    message: {
      id: messageId,
      author_id: String((message && message.author && message.author.id) || "").trim(),
      author_display_name: String(
        (message && message.member && message.member.displayName) ||
        (message && message.author && (message.author.globalName || message.author.username)) ||
        ""
      ).trim(),
      content: normalizedContent,
      created_at: messageCreatedAt,
      is_reply_to_bot: Boolean(isReplyToBot),
      mentions_bot: Boolean(mentionsBot),
      mentions_everyone: Boolean(message && message.mentions && message.mentions.everyone),
      role_mentions: normalizeRoleMentions(message && message.mentions),
      attachments: normalizeAttachments(message && message.attachments),
      links: collectLinks(content),
    },
    context: {
      recent_messages: recentMessages,
      active_thread_age_minutes: calculateActiveThreadAgeMinutes({
        recentMessages,
        currentMessageId: messageId,
        currentCreatedAt: messageCreatedAt,
      }),
      has_promised_followup: hasExplicitFollowupRequest(normalizedContent),
      matched_followup_ids: [],
    },
    memory: {
      member_ids: [],
      project_ids: [],
      daily_refs: [],
    },
  };
};

const validateOpenClawResponse = (response) => {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("invalid OpenClaw response: object required");
  }
  const action = String(response.action || "").trim();
  if (!POSTABLE_ACTIONS.has(action) && !NON_POSTING_ACTIONS.has(action)) {
    throw new Error(`invalid OpenClaw response action: ${action || "empty"}`);
  }
  return {
    schema_version: response.schema_version,
    action,
    body: normalizeMessageContent(response.body),
    requires_approval: Boolean(response.requires_approval),
    approval: response.approval && typeof response.approval === "object" ? response.approval : {},
  };
};

const containsBlockedMention = (body) => /@everyone|@here|<@&\d+>/i.test(String(body || ""));
const containsExternalLink = (body) => /https?:\/\/\S+/i.test(String(body || ""));

const runOutboundGate = ({ response, channelId, allowedChannelIds }) => {
  if (!allowedChannelIds.has(String(channelId || ""))) {
    return { ok: false, reason: "channel_not_verified" };
  }
  if (!POSTABLE_ACTIONS.has(response.action)) {
    return { ok: false, reason: `non_posting_action:${response.action}` };
  }
  if (response.requires_approval) {
    return { ok: false, reason: "requires_approval" };
  }
  if (!response.body) {
    return { ok: false, reason: "empty_body" };
  }
  if (containsBlockedMention(response.body)) {
    return { ok: false, reason: "blocked_mention" };
  }
  if (containsExternalLink(response.body)) {
    return { ok: false, reason: "external_link" };
  }
  const approval = response.approval || {};
  if (
    Array.isArray(approval.attachments) && approval.attachments.length > 0 ||
    Array.isArray(approval.links) && approval.links.length > 0 ||
    Array.isArray(approval.mentions) && approval.mentions.length > 0
  ) {
    return { ok: false, reason: "approval_side_effect" };
  }
  return { ok: true, reason: "ok" };
};

const buildSafeFailureMessage = () => "-# OpenClaw 直接実行に失敗しました。時間をおいてもう一度試してください。";
const buildGateBlockedMessage = () => "-# 今回は自動送信せず止めました。";
const MESSAGE_VISIBLE_GATE_REASONS = new Set([
  "blocked_mention",
  "external_link",
  "requires_approval",
  "approval_side_effect",
  "draft",
  "non_posting_action:draft",
  "publish_blocked",
  "non_posting_action:publish_blocked",
]);
const shouldReplyWithGateBlockedMessage = (reason) => MESSAGE_VISIBLE_GATE_REASONS.has(String(reason || ""));

const createOpenClawInteractionHandler = ({
  openClawClient,
  allowedChannelIds,
  guildId,
  contextEntriesSource,
  requestIdFactory = randomUUID,
  logger,
}) => {
  const allowed = new Set(allowedChannelIds);
  return async (interaction) => {
    if (!interaction.isChatInputCommand || !interaction.isChatInputCommand() || interaction.commandName !== "fairy") {
      return { handled: false };
    }
    if (String(interaction.guildId || "") !== String(guildId)) {
      const gate = { ok: false, reason: "guild_mismatch" };
      await interaction.reply({ content: buildGateBlockedMessage(), ephemeral: true, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, gate };
    }
    if (!allowed.has(String(interaction.channelId || ""))) {
      const gate = { ok: false, reason: "channel_not_verified" };
      await interaction.reply({ content: buildGateBlockedMessage(), ephemeral: true, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, gate };
    }
    await interaction.deferReply({ ephemeral: false });
    const content =
      interaction.options && typeof interaction.options.getString === "function"
        ? interaction.options.getString("request", false) || ""
        : "";
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: interaction.guildId,
      channel: { id: interaction.channelId, name: interaction.channel && interaction.channel.name },
      message: {
        id: interaction.id,
        author: interaction.user,
        member: interaction.member,
        channel: interaction.channel,
        createdAt: new Date(),
      },
      content,
      mentionsBot: true,
      allowedChannelIds: allowed,
      contextEntries: typeof contextEntriesSource === "function" ? await contextEntriesSource(interaction) : [],
    });
    payload.request_id = requestIdFactory();
    try {
      const response = validateOpenClawResponse(await openClawClient.execute(payload));
      const gate = runOutboundGate({ response, channelId: interaction.channelId, allowedChannelIds: allowed });
      if (!gate.ok) {
        await interaction.editReply({ content: buildGateBlockedMessage(), allowedMentions: SAFE_ALLOWED_MENTIONS });
        return { handled: true, requestId: payload.request_id, payload, response, gate };
      }
      await interaction.editReply({ content: response.body, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, response, gate };
    } catch (error) {
      if (logger) logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] interaction failed");
      await interaction.editReply({ content: buildSafeFailureMessage(), allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, error: String(error) };
    }
  };
};

const createOpenClawMessageHandler = ({
  openClawClient,
  allowedChannelIds,
  guildId,
  contextEntriesSource,
  requestIdFactory = randomUUID,
  logger,
}) => {
  const allowed = new Set(allowedChannelIds);
  return async (message, runtimeOptions = {}) => {
    if (!message || !message.content || !message.author || message.author.bot) {
      return { handled: false };
    }
    const channelId = String(message.channelId || (message.channel && message.channel.id) || "");
    if (String(message.guildId || "") !== String(guildId)) {
      return { handled: false, gate: { ok: false, reason: "guild_mismatch" } };
    }
    if (!allowed.has(channelId)) {
      return { handled: false, gate: { ok: false, reason: "channel_not_verified" } };
    }
    const content = stripBotMention(message.content, message.client && message.client.user && message.client.user.id);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: message.guildId,
      channel: { id: channelId, name: message.channel && message.channel.name },
      message,
      content,
      isReplyToBot: runtimeOptions.messageTriggerSource === "reply",
      mentionsBot: runtimeOptions.messageTriggerSource !== "reply",
      allowedChannelIds: allowed,
      contextEntries: typeof contextEntriesSource === "function" ? await contextEntriesSource(message) : [],
    });
    payload.request_id = requestIdFactory();
    const stopTyping = startTypingKeepalive({ channel: message.channel, logger });
    try {
      const response = validateOpenClawResponse(await openClawClient.execute(payload));
      const gate = runOutboundGate({ response, channelId, allowedChannelIds: allowed });
      if (!gate.ok) {
        if (shouldReplyWithGateBlockedMessage(gate.reason)) {
          const sentMessage = await message.reply({
            content: buildGateBlockedMessage(),
            allowedMentions: SAFE_ALLOWED_MENTIONS,
          });
          return {
            handled: true,
            requestId: payload.request_id,
            payload,
            response,
            gate,
            replyMessageId: sentMessage && sentMessage.id,
          };
        }
        return { handled: true, requestId: payload.request_id, payload, response, gate };
      }
      const sentMessage = await message.reply({ content: response.body, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return {
        handled: true,
        requestId: payload.request_id,
        payload,
        response,
        gate,
        replyMessageId: sentMessage && sentMessage.id,
      };
    } catch (error) {
      if (logger) logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] message failed");
      const sentMessage = await message.reply({ content: buildSafeFailureMessage(), allowedMentions: SAFE_ALLOWED_MENTIONS });
      return {
        handled: true,
        requestId: payload.request_id,
        payload,
        error: String(error),
        replyMessageId: sentMessage && sentMessage.id,
      };
    } finally {
      stopTyping();
    }
  };
};

module.exports = {
  DEFAULT_CHANNEL_REGISTRY,
  SAFE_ALLOWED_MENTIONS,
  buildOpenClawPayload,
  createOpenClawClient,
  createOpenClawInteractionHandler,
  createOpenClawMessageHandler,
  createOpenClawRuntimeConfig,
  normalizeRuntimeMode,
  parseAllowedChannelIds,
  runOutboundGate,
  validateOpenClawResponse,
};
