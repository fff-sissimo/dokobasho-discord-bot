"use strict";

const localFirstReplyModule = require("./fairy-first-reply-ai");

const LOCAL_SLOW_PATH_TRIGGER_SOURCES = Object.freeze(["slash_command", "mention", "reply"]);

const requiredPayloadKeys = [
  "request_id",
  "event_id",
  "application_id",
  "user_id",
  "channel_id",
  "guild_id",
  "command_name",
  "invocation_message",
  "context_excerpt",
  "context_meta",
  "created_at",
];

const optionalPayloadKeys = ["trigger_source", "source_message_id", "first_reply_message_id"];
const contextMetaKeys = [
  "considered_messages",
  "used_messages",
  "max_messages",
  "max_links",
  "max_chars",
  "collection_deadline_ms",
  "total_chars",
  "reached_deadline",
  "truncated",
];

const isRecord = (value) => typeof value === "object" && value !== null;
const ensureString = (value, field) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid field: ${field}`);
  }
};
const ensureNullableNonEmptyString = (value, field) => {
  if (value === null) return;
  ensureString(value, field);
};
const ensureNumber = (value, field) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`invalid field: ${field}`);
  }
};
const ensureBoolean = (value, field) => {
  if (typeof value !== "boolean") {
    throw new Error(`invalid field: ${field}`);
  }
};

const localAssertSlowPathJobPayloadContract = (payload) => {
  if (!isRecord(payload)) {
    throw new Error("payload must be an object");
  }

  const payloadKeys = Object.keys(payload);
  const missingKeys = requiredPayloadKeys.filter((key) => !payloadKeys.includes(key));
  if (missingKeys.length > 0) {
    throw new Error(`missing keys: ${missingKeys.join(",")}`);
  }

  const allowedKeys = new Set([...requiredPayloadKeys, ...optionalPayloadKeys]);
  const unexpectedKeys = payloadKeys.filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`unexpected keys: ${unexpectedKeys.join(",")}`);
  }

  ensureString(payload.request_id, "request_id");
  ensureString(payload.event_id, "event_id");
  ensureString(payload.application_id, "application_id");
  ensureString(payload.user_id, "user_id");
  ensureString(payload.channel_id, "channel_id");
  ensureNullableNonEmptyString(payload.guild_id, "guild_id");
  ensureString(payload.command_name, "command_name");
  ensureString(payload.invocation_message, "invocation_message");
  ensureString(payload.created_at, "created_at");

  if (!Array.isArray(payload.context_excerpt) || payload.context_excerpt.some((entry) => typeof entry !== "string")) {
    throw new Error("invalid field: context_excerpt");
  }

  const hasTriggerSource = Object.prototype.hasOwnProperty.call(payload, "trigger_source");
  const hasSourceMessageId = Object.prototype.hasOwnProperty.call(payload, "source_message_id");
  if (hasTriggerSource !== hasSourceMessageId) {
    throw new Error("trigger_source and source_message_id must be provided together");
  }
  if (hasTriggerSource && hasSourceMessageId) {
    if (!LOCAL_SLOW_PATH_TRIGGER_SOURCES.includes(payload.trigger_source)) {
      throw new Error("invalid field: trigger_source");
    }
    if (payload.trigger_source === "slash_command" && payload.source_message_id !== null) {
      throw new Error("invalid trigger/source pairing: slash_command requires sourceMessageId=null");
    }
    if (
      payload.trigger_source !== "slash_command" &&
      (typeof payload.source_message_id !== "string" || payload.source_message_id.length === 0)
    ) {
      throw new Error(
        `invalid trigger/source pairing: ${String(payload.trigger_source)} requires non-empty sourceMessageId`
      );
    }
  }

  if ("first_reply_message_id" in payload) {
    ensureNullableNonEmptyString(payload.first_reply_message_id, "first_reply_message_id");
  }

  if (!isRecord(payload.context_meta)) {
    throw new Error("invalid field: context_meta");
  }
  const payloadContextMeta = payload.context_meta;
  const payloadContextMetaKeys = Object.keys(payloadContextMeta);
  const missingContextMetaKeys = contextMetaKeys.filter((key) => !payloadContextMetaKeys.includes(key));
  if (missingContextMetaKeys.length > 0) {
    throw new Error(`missing context_meta keys: ${missingContextMetaKeys.join(",")}`);
  }

  ensureNumber(payloadContextMeta.considered_messages, "context_meta.considered_messages");
  ensureNumber(payloadContextMeta.used_messages, "context_meta.used_messages");
  ensureNumber(payloadContextMeta.max_messages, "context_meta.max_messages");
  ensureNumber(payloadContextMeta.max_links, "context_meta.max_links");
  ensureNumber(payloadContextMeta.max_chars, "context_meta.max_chars");
  ensureNumber(payloadContextMeta.collection_deadline_ms, "context_meta.collection_deadline_ms");
  ensureNumber(payloadContextMeta.total_chars, "context_meta.total_chars");
  ensureBoolean(payloadContextMeta.reached_deadline, "context_meta.reached_deadline");
  ensureBoolean(payloadContextMeta.truncated, "context_meta.truncated");
};

const defaultRequireImpl = (moduleName) => require(moduleName);

const createFairyCoreAdapter = ({ requireImpl = defaultRequireImpl } = {}) => {
  const source = {
    firstReply: "local-fallback",
    slowPath: "local-fallback",
  };

  const firstReply = {
    buildFallbackFirstReplyMessage: localFirstReplyModule.buildFallbackFirstReplyMessage,
    normalizeFirstReplyForDiscord: localFirstReplyModule.normalizeFirstReplyForDiscord,
    createOpenAiFirstReplyComposer: localFirstReplyModule.createOpenAiFirstReplyComposer,
  };

  const slowPath = {
    SLOW_PATH_TRIGGER_SOURCES: LOCAL_SLOW_PATH_TRIGGER_SOURCES,
    assertSlowPathJobPayloadContract: localAssertSlowPathJobPayloadContract,
  };

  try {
    const packageFirstReply = requireImpl("@fff-sissimo/fairy-core/first-reply");
    if (
      packageFirstReply &&
      typeof packageFirstReply.buildFallbackFirstReplyMessage === "function" &&
      typeof packageFirstReply.normalizeFirstReplyForDiscord === "function" &&
      typeof packageFirstReply.createOpenAiFirstReplyComposer === "function"
    ) {
      firstReply.buildFallbackFirstReplyMessage = packageFirstReply.buildFallbackFirstReplyMessage;
      firstReply.normalizeFirstReplyForDiscord = packageFirstReply.normalizeFirstReplyForDiscord;
      firstReply.createOpenAiFirstReplyComposer = packageFirstReply.createOpenAiFirstReplyComposer;
      source.firstReply = "package";
    }
  } catch (_error) {
    // local fallback
  }

  try {
    const packageSlowPath = requireImpl("@fff-sissimo/fairy-core/slow-path-payload");
    if (
      packageSlowPath &&
      Array.isArray(packageSlowPath.SLOW_PATH_TRIGGER_SOURCES) &&
      typeof packageSlowPath.assertSlowPathJobPayloadContract === "function"
    ) {
      slowPath.SLOW_PATH_TRIGGER_SOURCES = Object.freeze([...packageSlowPath.SLOW_PATH_TRIGGER_SOURCES]);
      slowPath.assertSlowPathJobPayloadContract = packageSlowPath.assertSlowPathJobPayloadContract;
      source.slowPath = "package";
    }
  } catch (_error) {
    // local fallback
  }

  return {
    ...firstReply,
    ...slowPath,
    source,
  };
};

const fairyCoreAdapter = createFairyCoreAdapter();

module.exports = {
  createFairyCoreAdapter,
  fairyCoreAdapter,
};
