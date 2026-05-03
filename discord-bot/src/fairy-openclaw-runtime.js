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

const normalizeMessageContent = (value) => String(value || "").replace(/\s+/g, " ").trim();

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
    }))
    .filter((entry) => entry.message_id && entry.author_id && entry.content && entry.author_is_bot === false)
    .map((entry) => ({
      message_id: entry.message_id,
      author_id: entry.author_id,
      content: entry.content,
    }));
};

const resolveChannel = ({ channel, channelId, allowedChannelIds }) => {
  const id = String(channelId || (channel && channel.id) || "").trim();
  const registered = allowedChannelIds.has(id);
  return {
    id,
    name: String((channel && channel.name) || "").trim(),
    type: registered ? "sandbox" : "unknown",
    registered,
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
  contextEntries = [],
}) => ({
  schema_version: 1,
  source: "discord",
  event_type: eventType,
  received_at: isoNow(),
  guild_id: String(guildId || "").trim(),
  channel: resolveChannel({
    channel: message && message.channel,
    channelId: channel && channel.id,
    allowedChannelIds,
  }),
  message: {
    id: String((message && message.id) || "").trim(),
    author_id: String((message && message.author && message.author.id) || "").trim(),
    author_display_name: String(
      (message && message.member && message.member.displayName) ||
      (message && message.author && (message.author.globalName || message.author.username)) ||
      ""
    ).trim(),
    content: normalizeMessageContent(content),
    created_at:
      message && message.createdAt && typeof message.createdAt.toISOString === "function"
        ? message.createdAt.toISOString()
        : isoNow(),
    is_reply_to_bot: Boolean(isReplyToBot),
    mentions_bot: Boolean(mentionsBot),
    mentions_everyone: Boolean(message && message.mentions && message.mentions.everyone),
    role_mentions: normalizeRoleMentions(message && message.mentions),
    attachments: normalizeAttachments(message && message.attachments),
    links: collectLinks(content),
  },
  context: {
    recent_messages: normalizeContextEntries(contextEntries),
    active_thread_age_minutes: null,
    has_promised_followup: false,
    matched_followup_ids: [],
  },
  memory: {
    member_ids: [],
    project_ids: [],
    daily_refs: [],
  },
});

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
    try {
      const response = validateOpenClawResponse(await openClawClient.execute(payload));
      const gate = runOutboundGate({ response, channelId, allowedChannelIds: allowed });
      if (!gate.ok) {
        return { handled: true, requestId: payload.request_id, payload, response, gate };
      }
      await message.reply({ content: response.body, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, response, gate };
    } catch (error) {
      if (logger) logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] message failed");
      await message.reply({ content: buildSafeFailureMessage(), allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, error: String(error) };
    }
  };
};

module.exports = {
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
