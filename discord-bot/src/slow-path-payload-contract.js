"use strict";

const SLOW_PATH_TRIGGER_SOURCES = Object.freeze(["slash_command", "mention", "reply"]);
const SLOW_PATH_SUPPORTED_SCHEMA_VERSIONS = Object.freeze(["2", "3"]);
const SLOW_PATH_LEGACY_PAYLOAD_SCHEMA_VERSION = "2";
const SLOW_PATH_PAYLOAD_SCHEMA_VERSION = "3";

const requiredSlowPathPayloadKeys = Object.freeze([
  "schema_version",
  "request_id",
  "event_id",
  "application_id",
  "user_id",
  "channel_id",
  "guild_id",
  "command_name",
  "trigger_source",
  "source_message_id",
  "first_reply_message_id",
  "invocation_message",
  "context_excerpt",
  "context_meta",
  "created_at",
]);
const optionalSlowPathPayloadKeys = Object.freeze(["context_entries", "reply_antecedent_entry"]);
const allowedSlowPathPayloadKeySet = new Set([...requiredSlowPathPayloadKeys, ...optionalSlowPathPayloadKeys]);
const contextMetaKeys = Object.freeze([
  "considered_messages",
  "used_messages",
  "max_messages",
  "max_links",
  "max_chars",
  "collection_deadline_ms",
  "total_chars",
  "reached_deadline",
  "truncated",
]);
const contextMetaKeySet = new Set(contextMetaKeys);
const slowPathTriggerSourceSet = new Set(SLOW_PATH_TRIGGER_SOURCES);
const slowPathPayloadSchemaVersionSet = new Set(SLOW_PATH_SUPPORTED_SCHEMA_VERSIONS);
const contextEntryKeys = Object.freeze(["message_id", "author_user_id", "author_is_bot", "content"]);
const contextEntryKeySet = new Set(contextEntryKeys);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const ensureString = (value, field) => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid field: ${field}`);
};

const ensureNumber = (value, field) => {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`invalid field: ${field}`);
};

const ensureBoolean = (value, field) => {
  if (typeof value !== "boolean") throw new Error(`invalid field: ${field}`);
};

const ensureNullableNonEmptyString = (value, field) => {
  if (value === null) return;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid field: ${field}`);
};

const ensureSchemaVersion = (value, field) => {
  if (typeof value !== "string" || !slowPathPayloadSchemaVersionSet.has(value)) {
    throw new Error(`invalid field: ${field}`);
  }
};

const ensureSlowPathTriggerSource = (value, field) => {
  if (typeof value !== "string" || !slowPathTriggerSourceSet.has(value)) {
    throw new Error(`invalid field: ${field}`);
  }
};

const ensureContextEntries = (value, field) => {
  if (!Array.isArray(value)) throw new Error(`invalid field: ${field}`);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new Error(`invalid field: ${field}[${index}]`);
    const keys = Object.keys(entry);
    const missingKeys = contextEntryKeys.filter((key) => !keys.includes(key));
    if (missingKeys.length > 0) throw new Error(`missing context_entries keys: ${missingKeys.join(",")}`);
    const unexpectedKeys = keys.filter((key) => !contextEntryKeySet.has(key));
    if (unexpectedKeys.length > 0) throw new Error(`unexpected context_entries keys: ${unexpectedKeys.join(",")}`);
    ensureString(entry.message_id, `context_entries[${index}].message_id`);
    ensureString(entry.author_user_id, `context_entries[${index}].author_user_id`);
    ensureBoolean(entry.author_is_bot, `context_entries[${index}].author_is_bot`);
    ensureString(entry.content, `context_entries[${index}].content`);
    if (entry.content.trim().length === 0) throw new Error(`invalid field: context_entries[${index}].content`);
  }
};

const ensureReplyAntecedentEntry = (value, field) => {
  if (!isRecord(value)) throw new Error(`invalid field: ${field}`);
  const keys = Object.keys(value);
  const missingKeys = contextEntryKeys.filter((key) => !keys.includes(key));
  if (missingKeys.length > 0) throw new Error(`missing ${field} keys: ${missingKeys.join(",")}`);
  const unexpectedKeys = keys.filter((key) => !contextEntryKeySet.has(key));
  if (unexpectedKeys.length > 0) throw new Error(`unexpected ${field} keys: ${unexpectedKeys.join(",")}`);
  ensureString(value.message_id, `${field}.message_id`);
  ensureString(value.author_user_id, `${field}.author_user_id`);
  ensureBoolean(value.author_is_bot, `${field}.author_is_bot`);
  ensureString(value.content, `${field}.content`);
  if (value.content.trim().length === 0) throw new Error(`invalid field: ${field}.content`);
};

const validateTriggerSourceAndSourceMessageId = (triggerSource, sourceMessageId) => {
  if (triggerSource === "slash_command" && sourceMessageId !== null) {
    throw new Error("invalid trigger/source pairing: slash_command requires sourceMessageId=null");
  }
  if (triggerSource !== "slash_command" && (typeof sourceMessageId !== "string" || sourceMessageId.length === 0)) {
    throw new Error(`invalid trigger/source pairing: ${triggerSource} requires non-empty sourceMessageId`);
  }
};

const validateSchemaVersionAndReplyAntecedent = (
  schemaVersion,
  payloadKeys,
  triggerSource,
  hasReplyAntecedentEntry
) => {
  if (schemaVersion === SLOW_PATH_LEGACY_PAYLOAD_SCHEMA_VERSION && payloadKeys.includes("reply_antecedent_entry")) {
    throw new Error("invalid field: reply_antecedent_entry");
  }
  if (hasReplyAntecedentEntry && triggerSource === "slash_command") {
    throw new Error("invalid trigger/antecedent pairing: slash_command forbids reply_antecedent_entry");
  }
};

const assertSlowPathJobPayloadContract = (payload) => {
  if (!isRecord(payload)) throw new Error("payload must be an object");
  const payloadKeys = Object.keys(payload);
  const missingKeys = requiredSlowPathPayloadKeys.filter((key) => !payloadKeys.includes(key));
  if (missingKeys.length > 0) throw new Error(`missing keys: ${missingKeys.join(",")}`);
  const unexpectedKeys = payloadKeys.filter((key) => !allowedSlowPathPayloadKeySet.has(key));
  if (unexpectedKeys.length > 0) throw new Error(`unexpected keys: ${unexpectedKeys.join(",")}`);

  ensureSchemaVersion(payload.schema_version, "schema_version");
  ensureString(payload.request_id, "request_id");
  ensureString(payload.event_id, "event_id");
  ensureString(payload.application_id, "application_id");
  ensureString(payload.user_id, "user_id");
  ensureString(payload.channel_id, "channel_id");
  ensureNullableNonEmptyString(payload.guild_id, "guild_id");
  ensureString(payload.command_name, "command_name");
  ensureSlowPathTriggerSource(payload.trigger_source, "trigger_source");
  ensureNullableNonEmptyString(payload.source_message_id, "source_message_id");
  validateTriggerSourceAndSourceMessageId(payload.trigger_source, payload.source_message_id);
  ensureNullableNonEmptyString(payload.first_reply_message_id, "first_reply_message_id");
  ensureString(payload.invocation_message, "invocation_message");
  ensureString(payload.created_at, "created_at");

  const hasReplyAntecedentEntry = payloadKeys.includes("reply_antecedent_entry");
  validateSchemaVersionAndReplyAntecedent(
    payload.schema_version,
    payloadKeys,
    payload.trigger_source,
    hasReplyAntecedentEntry
  );

  if (!Array.isArray(payload.context_excerpt) || payload.context_excerpt.some((entry) => typeof entry !== "string")) {
    throw new Error("invalid field: context_excerpt");
  }
  if (payload.context_entries !== undefined) ensureContextEntries(payload.context_entries, "context_entries");
  if (hasReplyAntecedentEntry) ensureReplyAntecedentEntry(payload.reply_antecedent_entry, "reply_antecedent_entry");

  if (!isRecord(payload.context_meta)) throw new Error("invalid field: context_meta");
  const payloadContextMeta = payload.context_meta;
  const payloadContextMetaKeys = Object.keys(payloadContextMeta);
  const missingContextMetaKeys = contextMetaKeys.filter((key) => !payloadContextMetaKeys.includes(key));
  if (missingContextMetaKeys.length > 0) throw new Error(`missing context_meta keys: ${missingContextMetaKeys.join(",")}`);
  const unexpectedContextMetaKeys = payloadContextMetaKeys.filter((key) => !contextMetaKeySet.has(key));
  if (unexpectedContextMetaKeys.length > 0) {
    throw new Error(`unexpected context_meta keys: ${unexpectedContextMetaKeys.join(",")}`);
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

module.exports = {
  SLOW_PATH_LEGACY_PAYLOAD_SCHEMA_VERSION,
  SLOW_PATH_PAYLOAD_SCHEMA_VERSION,
  SLOW_PATH_SUPPORTED_SCHEMA_VERSIONS,
  SLOW_PATH_TRIGGER_SOURCES,
  assertSlowPathJobPayloadContract,
};
