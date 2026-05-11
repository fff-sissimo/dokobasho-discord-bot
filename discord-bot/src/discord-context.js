"use strict";

const DEFAULT_DISCORD_CONTEXT_LIMITS = Object.freeze({
  maxMessages: 80,
  maxChars: 18000,
  maxCharsPerMessage: 900,
  fetchBatchSize: 100,
  maxBatches: 3,
  aroundLimit: 50,
  maxTargetMessages: 3,
});

const parsePositiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const resolveDiscordContextLimits = (env = process.env) => ({
  maxMessages: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_MAX_MESSAGES, DEFAULT_DISCORD_CONTEXT_LIMITS.maxMessages),
    1,
    100
  ),
  maxChars: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_MAX_CHARS, DEFAULT_DISCORD_CONTEXT_LIMITS.maxChars),
    1000,
    24000
  ),
  maxCharsPerMessage: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_MAX_CHARS_PER_MESSAGE, DEFAULT_DISCORD_CONTEXT_LIMITS.maxCharsPerMessage),
    200,
    2000
  ),
  fetchBatchSize: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_FETCH_BATCH_SIZE, DEFAULT_DISCORD_CONTEXT_LIMITS.fetchBatchSize),
    1,
    100
  ),
  maxBatches: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_MAX_FETCH_BATCHES, DEFAULT_DISCORD_CONTEXT_LIMITS.maxBatches),
    1,
    10
  ),
  aroundLimit: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_AROUND_LIMIT, DEFAULT_DISCORD_CONTEXT_LIMITS.aroundLimit),
    1,
    100
  ),
  maxTargetMessages: clamp(
    parsePositiveInt(env.FAIRY_CONTEXT_MAX_TARGET_MESSAGES, DEFAULT_DISCORD_CONTEXT_LIMITS.maxTargetMessages),
    0,
    10
  ),
});

const normalizeContent = (value, maxCharsPerMessage) =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, maxCharsPerMessage).trim();

const readIsoTimestamp = (message) => {
  if (message && message.createdAt && typeof message.createdAt.toISOString === "function") {
    return message.createdAt.toISOString();
  }
  if (Number.isFinite(message && message.createdTimestamp)) {
    return new Date(message.createdTimestamp).toISOString();
  }
  return "";
};

const isThreadChannel = (channel) =>
  Boolean(
    channel &&
      (channel.isThread === true ||
        channel.isThread === "true" ||
        (typeof channel.isThread === "function" && channel.isThread()))
  );

const readReplyToMessageId = (message) => {
  const referenceId = message && message.reference && message.reference.messageId;
  return typeof referenceId === "string" ? referenceId.trim() : "";
};

const buildEntry = (message, limits, contextSource = "recent") => ({
  message_id: typeof message.id === "string" ? message.id.trim() : "",
  channel_id: String((message && (message.channelId || (message.channel && message.channel.id))) || "").trim(),
  thread_id: isThreadChannel(message && message.channel)
    ? String((message && message.channel && message.channel.id) || "").trim()
    : "",
  reply_to_message_id: readReplyToMessageId(message),
  context_source: contextSource,
  author_user_id:
    message && message.author && typeof message.author.id === "string"
      ? message.author.id.trim()
      : "",
  author_display_name: String(
    (message && message.member && message.member.displayName) ||
      (message && message.author && (message.author.globalName || message.author.username)) ||
      ""
  ).trim(),
  author_is_bot: Boolean(message && message.author && message.author.bot),
  content: normalizeContent(message && message.content, limits.maxCharsPerMessage),
  created_at: readIsoTimestamp(message),
});

const parseDiscordMessageTargets = (content, guildId) => {
  const targets = [];
  const seen = new Set();
  const pattern = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/gi;
  for (const match of String(content || "").matchAll(pattern)) {
    const targetGuildId = String(match[1] || "");
    const channelId = String(match[2] || "");
    const messageId = String(match[3] || "");
    if (guildId && targetGuildId !== String(guildId)) continue;
    const key = `${channelId}:${messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ guild_id: targetGuildId, channel_id: channelId, message_id: messageId, source: "discord_url" });
  }
  return targets;
};

const readTargetMessages = (source, limits) => {
  const targets = [];
  const seen = new Set();
  const addTarget = (target) => {
    const key = `${target.channel_id}:${target.message_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  for (const target of parseDiscordMessageTargets(source && source.content, source && source.guildId)) {
    addTarget(target);
  }
  const referenceId = source && source.reference && source.reference.messageId;
  const sourceChannelId = String((source && (source.channelId || (source.channel && source.channel.id))) || "");
  if (referenceId && sourceChannelId) {
    addTarget({
      guild_id: String((source && source.guildId) || ""),
      channel_id: sourceChannelId,
      message_id: String(referenceId),
      source: "reply_reference",
    });
  }
  return targets.slice(0, limits.maxTargetMessages);
};

const isAllowedTargetChannel = (source, target) => {
  const sourceChannelId = String((source && (source.channelId || (source.channel && source.channel.id))) || "");
  const operationChannelId = String((source && source.operationChannelId) || "").trim();
  const allowedChannelIds = source && source.allowedChannelIds instanceof Set ? source.allowedChannelIds : null;
  if (target.channel_id === sourceChannelId || target.channel_id === operationChannelId) return true;
  return Boolean(allowedChannelIds && allowedChannelIds.has(target.channel_id));
};

const resolveTargetChannel = async (source, target) => {
  if (!isAllowedTargetChannel(source, target)) return null;
  const sourceChannelId = String((source && (source.channelId || (source.channel && source.channel.id))) || "");
  if (sourceChannelId && sourceChannelId === target.channel_id && source && source.channel) return source.channel;
  const client = source && source.client;
  if (!client || !client.channels || typeof client.channels.fetch !== "function") return null;
  try {
    return await client.channels.fetch(target.channel_id);
  } catch (_error) {
    return null;
  }
};

const addMessagesToSeen = ({ seen, messages, limits, contextSource }) => {
  for (const message of messages) {
    if (!message || typeof message.id !== "string") continue;
    const entry = seen.get(message.id) || { message, sources: new Set() };
    entry.sources.add(contextSource);
    seen.set(message.id, entry);
  }
};

const isExactTargetEntry = (entry) => /(?:^|,)(?:discord_url_target|reply_reference_target)(?:,|$)/.test(entry.context_source);

const isTargetEntry = (entry) => /(?:^|,)(?:discord_url|reply_reference)(?:_target)?(?:,|$)/.test(entry.context_source);

const selectWithinCharBudget = (orderedEntries, limits) => {
  const selected = [];
  const selectedIds = new Set();
  let totalChars = 0;
  let truncated = false;

  const tryAdd = (entry) => {
    if (selectedIds.has(entry.message_id)) return true;
    if (selected.length >= limits.maxMessages) {
      truncated = true;
      return false;
    }
    const nextTotal = totalChars + entry.content.length;
    if (nextTotal > limits.maxChars) {
      truncated = true;
      return false;
    }
    selected.push(entry);
    selectedIds.add(entry.message_id);
    totalChars = nextTotal;
    return true;
  };

  for (const entry of orderedEntries.filter(isExactTargetEntry)) {
    tryAdd(entry);
  }

  for (const entry of orderedEntries.filter((entry) => isTargetEntry(entry) && !isExactTargetEntry(entry))) {
    tryAdd(entry);
  }

  for (const entry of [...orderedEntries].reverse()) {
    tryAdd(entry);
  }

    return {
      entries: selected.sort((a, b) => {
        const left = Date.parse(a.created_at || "");
        const right = Date.parse(b.created_at || "");
        return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
      }),
      totalChars,
      truncated: truncated || selected.length < orderedEntries.length,
    };
};

const emptyContextResult = (reason, limits) => ({
  entries: [],
  meta: {
    scope: "unknown",
    reason,
    requested_messages: limits.maxMessages,
    fetched_messages: 0,
    used_messages: 0,
    max_chars: limits.maxChars,
    total_chars: 0,
    truncated: false,
    fetch_batches: 0,
    included_bot_messages: 0,
    oldest_message_id: "",
    newest_message_id: "",
  },
});

const collectRecentChannelContextEntries = async (source, options = {}) => {
  const limits = { ...DEFAULT_DISCORD_CONTEXT_LIMITS, ...(options.limits || {}) };
  const channel = source && source.channel;
  if (!channel || !channel.messages || typeof channel.messages.fetch !== "function") {
    return emptyContextResult("unsupported_channel", limits);
  }

  const seen = new Map();
  const targetMessages = readTargetMessages(source, limits);
  let before;
  let fetchBatches = 0;
  let targetFetches = 0;
  let targetFetchFailures = 0;

  for (const target of targetMessages) {
    const targetChannel = await resolveTargetChannel(source, target);
    if (!targetChannel || !targetChannel.messages || typeof targetChannel.messages.fetch !== "function") {
      targetFetchFailures += 1;
      continue;
    }
    try {
      const fetched = await targetChannel.messages.fetch({
        around: target.message_id,
        limit: limits.aroundLimit,
        cache: false,
      });
      targetFetches += 1;
      const messages = Array.from(fetched.values());
      const exactTarget = messages.find((message) => message && message.id === target.message_id);
      if (exactTarget) {
        addMessagesToSeen({
          seen,
          messages: [exactTarget],
          limits,
          contextSource: `${target.source}_target`,
        });
      }
      addMessagesToSeen({
        seen,
        messages,
        limits,
        contextSource: target.source,
      });
    } catch (_error) {
      targetFetchFailures += 1;
    }
  }

  let reason = "ok";
  let errorCode = "";
  try {
    while (seen.size < limits.maxMessages && fetchBatches < limits.maxBatches) {
      const limit = Math.min(limits.fetchBatchSize, limits.maxMessages - seen.size);
      if (limit <= 0) break;
      const request = before ? { limit, before, cache: false } : { limit, cache: false };
      const fetched = await channel.messages.fetch(request);
      fetchBatches += 1;
      const messages = Array.from(fetched.values());
      if (messages.length === 0) break;
      addMessagesToSeen({ seen, messages, limits, contextSource: "recent" });
      const oldest = messages.reduce((candidate, message) => {
        if (!candidate) return message;
        return (message.createdTimestamp || 0) < (candidate.createdTimestamp || 0) ? message : candidate;
      }, null);
      before = oldest && oldest.id;
      if (!before || messages.length < limit) break;
    }
  } catch (error) {
    reason = seen.size > 0 ? "partial_fetch_failed" : "fetch_failed";
    errorCode = String(error && (error.code || error.name) || "UNKNOWN").replace(/[^A-Z0-9_:-]+/gi, "_").slice(0, 64);
    if (seen.size === 0) {
      const empty = emptyContextResult(reason, limits);
      return { ...empty, meta: { ...empty.meta, error_code: errorCode } };
    }
  }

  const ordered = Array.from(seen.values())
    .sort((a, b) => (a.message.createdTimestamp || 0) - (b.message.createdTimestamp || 0))
    .map((item) => buildEntry(item.message, limits, Array.from(item.sources).sort().join(",")))
    .filter((entry) => entry.message_id && entry.author_user_id && entry.content);
  const selected = selectWithinCharBudget(ordered, limits);
  const entries = selected.entries;
  return {
    entries,
    meta: {
      scope: isThreadChannel(channel) ? "thread" : "channel",
      reason,
      error_code: errorCode,
      requested_messages: limits.maxMessages,
      fetched_messages: ordered.length,
      used_messages: entries.length,
      max_chars: limits.maxChars,
      total_chars: selected.totalChars,
      truncated: selected.truncated,
      fetch_batches: fetchBatches,
      target_fetches: targetFetches,
      target_fetch_failures: targetFetchFailures,
      target_messages: targetMessages,
      included_bot_messages: entries.filter((entry) => entry.author_is_bot).length,
      oldest_message_id: entries[0] ? entries[0].message_id : "",
      newest_message_id: entries[entries.length - 1] ? entries[entries.length - 1].message_id : "",
    },
  };
};

const collectRecentChannelContext = async (source, options = {}) => {
  const result = await collectRecentChannelContextEntries(source, options);
  return result.entries.map((entry) => entry.content);
};

module.exports = {
  DEFAULT_DISCORD_CONTEXT_LIMITS,
  collectRecentChannelContext,
  collectRecentChannelContextEntries,
  resolveDiscordContextLimits,
};
