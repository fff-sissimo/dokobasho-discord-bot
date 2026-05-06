"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_OPENCLAW_TIMEOUT_MS = 85000;
const DEFAULT_OPENCLAW_STATE_DIR = "/var/lib/dokobasho/fairy-openclaw-state";
const DISCORD_BOT_REPO_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_REPO_ROOT = path.resolve(__dirname, "../..");
const FAIRY_OPENCLAW_MEMORY_DIR = path.resolve(WORKSPACE_REPO_ROOT, "..", "dokobasho-fairy-openclaw", "memory");
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
  "1094907178671939654": Object.freeze({ name: "妖精さんより", type: "sandbox", status: "verified" }),
  "840827137451229210": Object.freeze({ name: "はじまりの酒場", type: "chat", status: "verified" }),
  "841686630271418429": Object.freeze({ name: "らくがきちょう", type: "creation", status: "known" }),
  "1311647968113332275": Object.freeze({ name: "アイデアボード", type: "board", status: "verified" }),
  "1465296404455882860": Object.freeze({ name: "vostok-vol02-general", type: "project", status: "pending" }),
  "1465295987236143319": Object.freeze({ name: "vostok-vol02-pd", type: "project", status: "pending" }),
  "1465296093427531960": Object.freeze({ name: "vostok-vol02-music", type: "project", status: "pending" }),
  "1465296285341847765": Object.freeze({ name: "vostok-vol02-artwork", type: "project", status: "pending" }),
  "1466404431217164288": Object.freeze({ name: "vostok-vol02-qa", type: "project", status: "pending" }),
  "840827137451229208": Object.freeze({ name: "更新・進行状況", type: "ops", status: "known" }),
  "852073750294822922": Object.freeze({ name: "管理用", type: "ops", status: "known" }),
});
const CHANNEL_REGISTRY_STATUSES = new Set(["verified", "pending", "known", "not-connected"]);
const FOLLOWUP_STATUSES = new Set(["open", "checked", "closed"]);
const FOLLOWUP_TEXT_MAX_LENGTH = 200;
const FOLLOWUP_KINDS = new Set([
  "explicit_request",
  "agreed_todo",
  "formal_quest",
  "creation_continuation",
  "test_only",
]);
const FOLLOWUP_BASES = new Set(["explicit_user_request", "agreed_in_thread", "due_followup", "unknown"]);

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

const isPathInsideOrSame = (basePath, targetPath) => {
  const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relativePath === "" || (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const assertSafeOpenClawStateDir = (stateDir) => {
  const unsafeRoots = [
    WORKSPACE_REPO_ROOT,
    DISCORD_BOT_REPO_ROOT,
    FAIRY_OPENCLAW_MEMORY_DIR,
  ];
  const unsafeRoot = unsafeRoots.find((root) => isPathInsideOrSame(root, stateDir));
  if (unsafeRoot) {
    throw new Error(`invalid FAIRY_OPENCLAW_STATE_DIR: must be outside git-tracked runtime paths (${unsafeRoot})`);
  }
};

const resolveOpenClawStateDir = (env = process.env) => {
  const hasOverride = env && Object.prototype.hasOwnProperty.call(env, "FAIRY_OPENCLAW_STATE_DIR");
  const rawStateDir = hasOverride ? env.FAIRY_OPENCLAW_STATE_DIR : DEFAULT_OPENCLAW_STATE_DIR;
  const trimmedStateDir = String(rawStateDir || "").trim();
  if (!trimmedStateDir) {
    throw new Error("invalid FAIRY_OPENCLAW_STATE_DIR: absolute path required");
  }
  if (!path.isAbsolute(trimmedStateDir)) {
    throw new Error("invalid FAIRY_OPENCLAW_STATE_DIR: absolute path required");
  }
  const stateDir = path.resolve(trimmedStateDir);
  assertSafeOpenClawStateDir(stateDir);
  return stateDir;
};

const normalizeChannelRegistryEntry = (id, entry) => {
  if (!/^\d+$/.test(id)) {
    throw new Error(`invalid OpenClaw channel registry id: ${id || "empty"}`);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`invalid OpenClaw channel registry entry: ${id}`);
  }
  const name = String(entry.name || "").trim();
  const type = String(entry.type || "").trim();
  const status = String(
    entry.status ||
      entry.registry_status ||
      (entry.verified === true ? "verified" : entry.verified === false ? "pending" : "")
  ).trim();
  if (!name) throw new Error(`invalid OpenClaw channel registry name: ${id}`);
  if (!type) throw new Error(`invalid OpenClaw channel registry type: ${id}`);
  if (!CHANNEL_REGISTRY_STATUSES.has(status)) {
    throw new Error(`invalid OpenClaw channel registry status: ${id}`);
  }
  return Object.freeze({ name, type, status });
};

const validateOpenClawChannelRegistry = (registry) => {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("invalid OpenClaw channel registry: object required");
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(registry).map(([rawId, entry]) => {
        const id = String(rawId || "").trim();
        return [id, normalizeChannelRegistryEntry(id, entry)];
      })
    )
  );
};

const parseChannelRegistrySource = (raw) => {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error("invalid OpenClaw channel registry JSON");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.channels)) {
    return Object.fromEntries(
      parsed.channels
        .map((entry) => {
          const id = String(entry && (entry.id || entry.channel_id) ? entry.id || entry.channel_id : "").trim();
          return [id, entry];
        })
        .filter(([id]) => /^\d+$/.test(id))
    );
  }
  if (Array.isArray(parsed)) {
    return Object.fromEntries(
      parsed
        .map((entry) => {
          const id = String(entry && (entry.id || entry.channel_id) ? entry.id || entry.channel_id : "").trim();
          return [id, entry];
        })
        .filter(([id]) => /^\d+$/.test(id))
    );
  }
  return parsed;
};

const loadOpenClawChannelRegistry = (source = {}) => {
  const registrySource =
    typeof source === "string"
      ? parseChannelRegistrySource(source)
      : source && source.FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON
        ? parseChannelRegistrySource(source.FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON)
        : source && source.channelRegistry
          ? source.channelRegistry
          : {};
  return validateOpenClawChannelRegistry({
    ...DEFAULT_CHANNEL_REGISTRY,
    ...registrySource,
  });
};

const assertAllowlistIsVerified = ({ allowedChannelIds, channelRegistry }) => {
  const unknownOrUnverified = allowedChannelIds.filter((id) => {
    const entry = channelRegistry[id];
    return !entry || entry.status !== "verified";
  });
  if (unknownOrUnverified.length > 0) {
    throw new Error(`invalid OpenClaw channel allowlist: unverified channel ids: ${unknownOrUnverified.join(", ")}`);
  }
};

const resolveOpenClawApiUrl = (env = process.env) => {
  const baseUrl = String(env.OPENCLAW_API_BASE_URL || "").trim();
  const legacyUrl = String(env.OPENCLAW_API_URL || "").trim();
  if (baseUrl && legacyUrl && baseUrl !== legacyUrl) {
    throw new Error("conflicting OpenClaw API config: OPENCLAW_API_BASE_URL and OPENCLAW_API_URL differ");
  }
  const apiUrl = baseUrl || legacyUrl;
  if (!apiUrl) return "";
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("invalid OpenClaw API config: OPENCLAW_API_BASE_URL must be a complete URL");
  }
  const endpointPath = parsed.pathname.replace(/\/+$/, "");
  if (!/^https?:$/.test(parsed.protocol) || endpointPath !== "/discord/respond") {
    throw new Error("invalid OpenClaw API config: OPENCLAW_API_BASE_URL must end with /discord/respond");
  }
  return apiUrl;
};

const createOpenClawRuntimeConfig = (env = process.env) => {
  const mode = normalizeRuntimeMode(env.FAIRY_RUNTIME_MODE);
  if (mode !== "openclaw") {
    return { mode };
  }

  const apiUrl = resolveOpenClawApiUrl(env);
  const apiKey = String(env.OPENCLAW_API_KEY || "").trim();
  const guildId = String(env.GUILD_ID || env.DISCORD_GUILD_ID || "").trim();
  const allowedChannelIds = parseAllowedChannelIds(env.FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS);
  const missing = [];
  if (!apiUrl) missing.push("OPENCLAW_API_BASE_URL");
  if (!apiKey) missing.push("OPENCLAW_API_KEY");
  if (!guildId) missing.push("GUILD_ID");
  if (allowedChannelIds.length === 0) missing.push("FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS");
  if (missing.length > 0) {
    throw new Error(`missing OpenClaw runtime config: ${missing.join(", ")}`);
  }
  const channelRegistry = loadOpenClawChannelRegistry(env);
  assertAllowlistIsVerified({ allowedChannelIds, channelRegistry });

  return {
    mode,
    apiUrl,
    apiKey,
    guildId,
    allowedChannelIds,
    channelRegistry,
    stateDir: resolveOpenClawStateDir(env),
    timeoutMs: parsePositiveInt(env.OPENCLAW_API_TIMEOUT_MS, DEFAULT_OPENCLAW_TIMEOUT_MS),
  };
};

const createEmptyFollowupState = () => ({ schema_version: 1, followups: [] });

const readJsonFile = async (filePath, fallbackFactory) => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallbackFactory();
    throw error;
  }
};

const writeJsonFile = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const isUnsafeFollowupText = (value) => {
  const text = normalizeMessageContent(value);
  if (!text) return false;
  if (text.length > FOLLOWUP_TEXT_MAX_LENGTH) return true;
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (/(?:api[_-]?key|token|secret|password|passwd|key)\s*[:=]\s*[^\s]+/i.test(text)) return true;
  if (/(?:bearer|basic)\s+[a-z0-9._~+/=-]{12,}/i.test(text)) return true;
  return false;
};

const normalizeSafeFollowupText = (value) => {
  const text = normalizeMessageContent(value);
  return text && !isUnsafeFollowupText(text) ? text : "";
};

const normalizeNullableIsoTimestamp = (value) => normalizeIsoTimestamp(value) || null;
const hasOwn = (source, key) => Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
const pickOwn = (primary, key, fallback, fallbackKey = key) =>
  hasOwn(primary, key) ? primary[key] : fallback && fallback[fallbackKey];
const pickMetadataIdentifier = (metadata, snakeKey, candidate, camelKey) =>
  hasOwn(metadata, snakeKey)
    ? metadata[snakeKey]
    : hasOwn(candidate, snakeKey)
      ? candidate[snakeKey]
      : candidate && candidate[camelKey];
const normalizeSafeIdentifier = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 80) return "";
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) return "";
  if (/https?:\/\//i.test(text)) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd|key)\s*[:=]/i.test(text)) return "";
  if (/(?:bearer|basic)[_.:-]?[a-z0-9._~+/=-]{8,}/i.test(text)) return "";
  return text;
};

const normalizeFollowupCandidates = (candidates) => {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate))
    .map((candidate) => {
      const metadata = candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? candidate.metadata
        : {};
      const kind = String(pickOwn(metadata, "kind", candidate) || "").trim();
      const basis = String(pickOwn(metadata, "basis", candidate) || "").trim();
      return {
        summary: normalizeSafeFollowupText(candidate.summary || candidate.title || candidate.label),
        due_at: normalizeIsoTimestamp(candidate.due_at || candidate.dueAt || candidate.datetime || candidate.when),
        notes: normalizeSafeFollowupText(candidate.notes || candidate.note),
        kind: FOLLOWUP_KINDS.has(kind) ? kind : "explicit_request",
        basis: FOLLOWUP_BASES.has(basis) ? basis : "unknown",
        assignee_member_id: normalizeSafeIdentifier(
          pickMetadataIdentifier(metadata, "assignee_member_id", candidate, "assigneeMemberId")
        ),
        source_followup_id: normalizeSafeIdentifier(
          pickMetadataIdentifier(metadata, "source_followup_id", candidate, "sourceFollowupId")
        ),
      };
    })
    .filter((candidate) => candidate.summary && candidate.due_at);
};

const normalizeFollowupIdList = (ids) =>
  (Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id || "").trim())
    .filter(Boolean);

const normalizePersistedFollowup = (followup) => {
  if (!followup || typeof followup !== "object" || Array.isArray(followup)) return null;
  const status = String(followup.status || "").trim();
  if (!FOLLOWUP_STATUSES.has(status)) return null;
  return {
    id: String(followup.id || "").trim(),
    status,
    channel_id: String(followup.channel_id || "").trim(),
    channel_type: String(followup.channel_type || "").trim(),
    source_message_id: String(followup.source_message_id || "").trim(),
    requested_by_member_id: String(followup.requested_by_member_id || "").trim(),
    summary: normalizeSafeFollowupText(followup.summary),
    due_at: normalizeNullableIsoTimestamp(followup.due_at),
    kind: FOLLOWUP_KINDS.has(String(followup.kind || "").trim()) ? String(followup.kind).trim() : "explicit_request",
    basis: FOLLOWUP_BASES.has(String(followup.basis || "").trim()) ? String(followup.basis).trim() : "unknown",
    assignee_member_id: normalizeSafeIdentifier(followup.assignee_member_id),
    source_followup_id: normalizeSafeIdentifier(followup.source_followup_id),
    created_at: normalizeNullableIsoTimestamp(followup.created_at),
    last_checked_at: normalizeNullableIsoTimestamp(followup.last_checked_at),
    closed_at: normalizeNullableIsoTimestamp(followup.closed_at),
    notes: normalizeSafeFollowupText(followup.notes),
  };
};

const normalizeFollowupMetadata = (metadata = {}) => ({
  channel_id: String(metadata.channel_id || "").trim(),
  channel_type: String(metadata.channel_type || "").trim(),
  source_message_id: String(metadata.source_message_id || "").trim(),
  requested_by_member_id: String(metadata.requested_by_member_id || "").trim(),
  has_promised_followup: Boolean(metadata.has_promised_followup),
});

const evaluateFollowupCandidateGate = ({ metadata, candidate }) => {
  const channelType = String(metadata && metadata.channel_type || "unknown").trim() || "unknown";
  if (!candidate || !candidate.summary || !candidate.due_at) {
    return { ok: false, reason: "invalid_candidate" };
  }
  if (channelType === "ops" || channelType === "unknown") {
    return { ok: false, reason: `channel_type_denied:${channelType}` };
  }
  if (channelType === "sandbox") {
    return candidate.kind === "test_only" || Boolean(metadata.has_promised_followup)
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "sandbox_requires_test_or_explicit_request" };
  }
  if (channelType === "chat") {
    return candidate.kind === "explicit_request" && candidate.basis === "explicit_user_request"
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "chat_requires_explicit_request" };
  }
  if (channelType === "board") {
    return candidate.kind === "formal_quest" ||
      (candidate.kind === "explicit_request" && candidate.basis === "agreed_in_thread")
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "board_requires_formal_quest_or_continuation" };
  }
  if (channelType === "project") {
    return candidate.kind === "agreed_todo" && candidate.basis === "agreed_in_thread" && Boolean(candidate.due_at)
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "project_requires_agreed_todo" };
  }
  if (channelType === "creation") {
    return candidate.kind === "creation_continuation" && candidate.basis === "explicit_user_request"
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "creation_requires_explicit_continuation" };
  }
  return { ok: false, reason: `channel_type_denied:${channelType}` };
};

const normalizeHeartbeatState = (patch = {}) => {
  const sourceLastChecks = patch && typeof patch.lastChecks === "object" && !Array.isArray(patch.lastChecks)
    ? patch.lastChecks
    : {};
  return {
    schema_version: 1,
    lastChecks: {
      server_flow: normalizeNullableIsoTimestamp(sourceLastChecks.server_flow),
      memory_maintenance: normalizeNullableIsoTimestamp(sourceLastChecks.memory_maintenance),
      followups: normalizeNullableIsoTimestamp(sourceLastChecks.followups),
    },
  };
};

const createOpenClawStateStore = ({
  stateDir = DEFAULT_OPENCLAW_STATE_DIR,
  idFactory = randomUUID,
  now = isoNow,
} = {}) => {
  const rootDir = String(stateDir || DEFAULT_OPENCLAW_STATE_DIR).trim() || DEFAULT_OPENCLAW_STATE_DIR;
  const followupsPath = path.join(rootDir, "followups.json");
  const heartbeatPath = path.join(rootDir, "heartbeat-state.json");

  const readFollowupState = async () => {
    const state = await readJsonFile(followupsPath, createEmptyFollowupState);
    return {
      schema_version: 1,
      followups: Array.isArray(state.followups) ? state.followups : [],
    };
  };

  const writeFollowupState = async (state) => {
    const nextState = {
      schema_version: 1,
      followups: (Array.isArray(state && state.followups) ? state.followups : [])
        .map(normalizePersistedFollowup)
        .filter(Boolean),
    };
    await writeJsonFile(followupsPath, nextState);
    return nextState;
  };

  const addFollowupCandidates = async ({ metadata, candidates }) => {
    const normalizedCandidates = normalizeFollowupCandidates(candidates);
    const normalizedMetadata = normalizeFollowupMetadata(metadata);
    if (normalizedCandidates.length === 0) {
      return [];
    }
    const allowedCandidates = normalizedCandidates.filter((candidate) =>
      evaluateFollowupCandidateGate({ metadata: normalizedMetadata, candidate }).ok
    );
    if (allowedCandidates.length === 0) {
      return [];
    }
    const createdAt = now();
    const state = await readFollowupState();
    const additions = allowedCandidates.map((candidate) => ({
      id: idFactory(),
      channel_id: normalizedMetadata.channel_id,
      channel_type: normalizedMetadata.channel_type,
      source_message_id: normalizedMetadata.source_message_id,
      requested_by_member_id: normalizedMetadata.requested_by_member_id,
      summary: candidate.summary,
      due_at: candidate.due_at,
      kind: candidate.kind,
      basis: candidate.basis,
      assignee_member_id: candidate.assignee_member_id,
      source_followup_id: candidate.source_followup_id,
      created_at: createdAt,
      status: "open",
      last_checked_at: null,
      closed_at: null,
      notes: candidate.notes,
    }));
    const nextState = await writeFollowupState({ ...state, followups: [...state.followups, ...additions] });
    return nextState.followups.slice(-additions.length);
  };

  const listDueOpenFollowups = async ({ channelId, now: nowValue = now() } = {}) => {
    const state = await readFollowupState();
    const dueMs = Date.parse(nowValue);
    if (!Number.isFinite(dueMs)) return [];
    const normalizedChannelId = String(channelId || "").trim();
    return state.followups.filter((followup) => {
      if (!followup || followup.status !== "open") return false;
      if (normalizedChannelId && String(followup.channel_id || "") !== normalizedChannelId) return false;
      const followupDueMs = Date.parse(followup.due_at);
      return Number.isFinite(followupDueMs) && followupDueMs <= dueMs;
    });
  };

  const markFollowupsChecked = async (ids, { checkedAt = now(), notes = "" } = {}) => {
    const targetIds = new Set(normalizeFollowupIdList(ids));
    if (targetIds.size === 0) return [];
    const state = await readFollowupState();
    const updated = [];
    const followups = state.followups.map((followup) => {
      if (!followup || !targetIds.has(String(followup.id || "")) || followup.status !== "open") return followup;
      const next = {
        ...followup,
        status: "checked",
        last_checked_at: normalizeIsoTimestamp(checkedAt) || now(),
        notes: normalizeSafeFollowupText(notes) || followup.notes || "",
      };
      updated.push(next);
      return next;
    });
    await writeFollowupState({ ...state, followups });
    return updated;
  };

  const closeFollowups = async (ids, { closedAt = now(), notes = "" } = {}) => {
    const targetIds = new Set(normalizeFollowupIdList(ids));
    if (targetIds.size === 0) return [];
    const state = await readFollowupState();
    const updated = [];
    const followups = state.followups.map((followup) => {
      if (!followup || !targetIds.has(String(followup.id || "")) || followup.status === "closed") return followup;
      const next = {
        ...followup,
        status: "closed",
        closed_at: normalizeIsoTimestamp(closedAt) || now(),
        notes: normalizeSafeFollowupText(notes) || followup.notes || "",
      };
      updated.push(next);
      return next;
    });
    await writeFollowupState({ ...state, followups });
    return updated;
  };

  const writeHeartbeatState = async (patch = {}) => {
    const state = normalizeHeartbeatState(patch);
    await writeJsonFile(heartbeatPath, state);
    return state;
  };

  return {
    stateDir: rootDir,
    followupsPath,
    heartbeatPath,
    readFollowupState,
    writeFollowupState,
    addFollowupCandidates,
    listDueOpenFollowups,
    markFollowupsChecked,
    closeFollowups,
    writeHeartbeatState,
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

const readSnowflake = (...values) => {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
};

const resolveChannelMetadata = (channel) => {
  const isThread = Boolean(
    channel &&
      (channel.isThread === true ||
        channel.isThread === "true" ||
        typeof channel.isThread === "function" && channel.isThread())
  );
  const parentChannel = channel && channel.parent ? channel.parent : null;
  const category = parentChannel && parentChannel.parent ? parentChannel.parent : null;
  return {
    thread_id: isThread ? readSnowflake(channel && channel.id) : "",
    parent_channel_id: isThread ? readSnowflake(channel && channel.parentId, parentChannel && parentChannel.id) : "",
    category_id: readSnowflake(
      channel && channel.parentId && !isThread ? channel.parentId : "",
      channel && channel.parent && channel.parentId && isThread ? channel.parent.parentId : "",
      parentChannel && parentChannel.parentId,
      category && category.id
    ),
  };
};

const isThreadChannel = (channel) =>
  Boolean(
    channel &&
      (channel.isThread === true ||
        channel.isThread === "true" ||
        (typeof channel.isThread === "function" && channel.isThread()))
  );

const resolveOperationChannelId = (channel, fallbackChannelId) => {
  if (isThreadChannel(channel)) {
    return readSnowflake(channel && channel.parentId, channel && channel.parent && channel.parent.id, fallbackChannelId);
  }
  return readSnowflake(fallbackChannelId, channel && channel.id);
};

const resolveChannel = ({ channel, channelId, allowedChannelIds, channelRegistry = DEFAULT_CHANNEL_REGISTRY }) => {
  const id = String(channelId || (channel && channel.id) || "").trim();
  const registeredChannel = channelRegistry[id] || null;
  const registered = Boolean(registeredChannel);
  const verified = registered && registeredChannel.status === "verified" && allowedChannelIds.has(id);
  return {
    id,
    name: String((channel && channel.name) || (registeredChannel && registeredChannel.name) || "").trim(),
    type: verified ? registeredChannel.type : "unknown",
    registered: verified,
    ...resolveChannelMetadata(channel),
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

const applyRuntimeStateToPayload = async ({ payload, stateStore, logger }) => {
  if (!payload || !stateStore) return payload;
  try {
    if (typeof stateStore.listDueOpenFollowups === "function") {
      const dueFollowups = await stateStore.listDueOpenFollowups({
        channelId: payload.channel && payload.channel.id,
        now: payload.received_at,
      });
      payload.context.matched_followup_ids = dueFollowups
        .map((followup) => String(followup && followup.id || "").trim())
        .filter(Boolean)
        .slice(0, 20);
    }
    if (typeof stateStore.writeHeartbeatState === "function") {
      await stateStore.writeHeartbeatState({
        lastChecks: {
          followups: payload.received_at,
        },
      });
    }
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] failed to load runtime state");
    }
  }
  return payload;
};

const saveResponseFollowupCandidates = async ({ payload, response, stateStore, logger }) => {
  if (!payload || !response || !stateStore || typeof stateStore.addFollowupCandidates !== "function") return [];
  const metadata = {
    channel_id: payload.channel && payload.channel.id,
    channel_type: payload.channel && payload.channel.type,
    source_message_id: payload.message && payload.message.id,
    requested_by_member_id: payload.message && payload.message.author_id,
    has_promised_followup: payload.context && payload.context.has_promised_followup,
  };
  if (logger && typeof logger.info === "function") {
    for (const candidate of response.followup_candidates || []) {
      const gate = evaluateFollowupCandidateGate({ metadata, candidate });
      if (!gate.ok) {
        logger.info({
          channel_id: metadata.channel_id,
          channel_type: metadata.channel_type,
          candidate_id: candidate.source_followup_id || "",
          gate_result: "deny",
          deny_reason: gate.reason,
        }, "[fairy-openclaw] followup candidate denied");
      }
    }
  }
  try {
    return await stateStore.addFollowupCandidates({
      metadata,
      candidates: response.followup_candidates,
    });
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] failed to save followup candidates");
    }
    return [];
  }
};

const applyResponseFollowupTransitions = async ({ payload, response, stateStore, logger }) => {
  if (!payload || !response || !stateStore) return { checked: [], closed: [] };
  try {
    const checked =
      typeof stateStore.markFollowupsChecked === "function"
        ? await stateStore.markFollowupsChecked(response.checked_followup_ids)
        : [];
    const closed =
      typeof stateStore.closeFollowups === "function" ? await stateStore.closeFollowups(response.closed_followup_ids) : [];
    return { checked, closed };
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({ err: error, requestId: payload.request_id }, "[fairy-openclaw] failed to update followup state");
    }
    return { checked: [], closed: [] };
  }
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
    followup_candidates: normalizeFollowupCandidates(response.followup_candidates),
    checked_followup_ids: normalizeFollowupIdList(response.checked_followup_ids),
    closed_followup_ids: normalizeFollowupIdList(response.closed_followup_ids),
  };
};

const containsBlockedMention = (body) => /@everyone|@here|<@&\d+>/i.test(String(body || ""));
const containsExternalLink = (body) => /https?:\/\/\S+/i.test(String(body || ""));
const containsSecretLikeText = (body) => {
  const text = String(body || "");
  return /(?:^|[\s"'`({\[])(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(text) ||
    /(?:^|[\s"'`({\[])[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(text) ||
    /(?:^|[\s"'`({\[])authorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text) ||
    /(?:^|[\s"'`({\[])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text);
};
const payloadHasInputRisk = (payload) => {
  const message = payload && payload.message ? payload.message : {};
  const content = String(message.content || "");
  if (/@everyone|@here/i.test(content)) return "input_everyone_or_here";
  if (/<@&\d+>/i.test(content)) return "input_role_mention";
  if (message.mentions_everyone) return "input_everyone_or_here";
  if (Array.isArray(message.role_mentions) && message.role_mentions.length > 0) return "input_role_mention";
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return "input_attachment";
  if (Array.isArray(message.links) && message.links.length > 0) return "input_external_link";
  return "";
};
const runInputRiskGate = (payload) => {
  const reason = payloadHasInputRisk(payload);
  return reason ? { ok: false, reason } : { ok: true, reason: "ok" };
};

const runOutboundGate = ({ response, channelId, allowedChannelIds, payload, channelMetadata }) => {
  if (!allowedChannelIds.has(String(channelId || ""))) {
    return { ok: false, reason: "channel_not_verified" };
  }
  const channelType = String(
    (channelMetadata && channelMetadata.type) ||
      (payload && payload.channel && payload.channel.type) ||
      ""
  ).trim();
  const inputRiskReason = payloadHasInputRisk(payload);
  if (inputRiskReason) {
    return { ok: false, reason: inputRiskReason };
  }
  if (channelType === "ops" && POSTABLE_ACTIONS.has(response.action)) {
    return { ok: false, reason: "ops_draft_only" };
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
  if (containsSecretLikeText(response.body)) {
    return { ok: false, reason: "secret_like_output" };
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
  "secret_like_output",
  "requires_approval",
  "approval_side_effect",
  "input_everyone_or_here",
  "input_role_mention",
  "input_attachment",
  "input_external_link",
  "ops_draft_only",
  "draft",
  "non_posting_action:draft",
  "publish_blocked",
  "non_posting_action:publish_blocked",
]);
const shouldReplyWithGateBlockedMessage = (reason) => MESSAGE_VISIBLE_GATE_REASONS.has(String(reason || ""));
const isExplicitMessageTrigger = (source) => source === "mention" || source === "reply";

const createOpenClawInteractionHandler = ({
  openClawClient,
  allowedChannelIds,
  guildId,
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
  stateStore,
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
    const operationChannelId = resolveOperationChannelId(interaction.channel, interaction.channelId);
    if (!allowed.has(operationChannelId)) {
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
      channel: { id: operationChannelId, name: interaction.channel && interaction.channel.name },
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
      channelRegistry,
      contextEntries: typeof contextEntriesSource === "function" ? await contextEntriesSource(interaction) : [],
    });
    payload.request_id = requestIdFactory();
    const inputGate = runInputRiskGate(payload);
    if (!inputGate.ok) {
      await interaction.editReply({ content: buildGateBlockedMessage(), allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, gate: inputGate };
    }
    await applyRuntimeStateToPayload({ payload, stateStore, logger });
    try {
      const response = validateOpenClawResponse(await openClawClient.execute(payload));
      await applyResponseFollowupTransitions({ payload, response, stateStore, logger });
      await saveResponseFollowupCandidates({ payload, response, stateStore, logger });
      const gate = runOutboundGate({
        response,
        channelId: operationChannelId,
        allowedChannelIds: allowed,
        payload,
        channelMetadata: payload.channel,
      });
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
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
  stateStore,
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
    const operationChannelId = resolveOperationChannelId(message.channel, channelId);
    if (String(message.guildId || "") !== String(guildId)) {
      return { handled: false, gate: { ok: false, reason: "guild_mismatch" } };
    }
    if (!allowed.has(operationChannelId)) {
      return { handled: false, gate: { ok: false, reason: "channel_not_verified" } };
    }
    const content = stripBotMention(message.content, message.client && message.client.user && message.client.user.id);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: message.guildId,
      channel: { id: operationChannelId, name: message.channel && message.channel.name },
      message,
      content,
      isReplyToBot: runtimeOptions.messageTriggerSource === "reply",
      mentionsBot: runtimeOptions.messageTriggerSource !== "reply",
      allowedChannelIds: allowed,
      channelRegistry,
      contextEntries: typeof contextEntriesSource === "function" ? await contextEntriesSource(message) : [],
    });
    payload.request_id = requestIdFactory();
    const inputGate = runInputRiskGate(payload);
    if (!inputGate.ok) {
      if (isExplicitMessageTrigger(runtimeOptions.messageTriggerSource)) {
        const sentMessage = await message.reply({
          content: buildGateBlockedMessage(),
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
        return {
          handled: true,
          requestId: payload.request_id,
          payload,
          gate: inputGate,
          replyMessageId: sentMessage && sentMessage.id,
        };
      }
      return { handled: true, requestId: payload.request_id, payload, gate: inputGate };
    }
    const stopTyping = startTypingKeepalive({ channel: message.channel, logger });
    await applyRuntimeStateToPayload({ payload, stateStore, logger });
    try {
      const response = validateOpenClawResponse(await openClawClient.execute(payload));
      await applyResponseFollowupTransitions({ payload, response, stateStore, logger });
      await saveResponseFollowupCandidates({ payload, response, stateStore, logger });
      const gate = runOutboundGate({
        response,
        channelId: operationChannelId,
        allowedChannelIds: allowed,
        payload,
        channelMetadata: payload.channel,
      });
      if (!gate.ok) {
        if (
          shouldReplyWithGateBlockedMessage(gate.reason) &&
          isExplicitMessageTrigger(runtimeOptions.messageTriggerSource)
        ) {
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
  DEFAULT_OPENCLAW_STATE_DIR,
  SAFE_ALLOWED_MENTIONS,
  buildOpenClawPayload,
  createOpenClawClient,
  createOpenClawInteractionHandler,
  createOpenClawMessageHandler,
  createOpenClawRuntimeConfig,
  createOpenClawStateStore,
  loadOpenClawChannelRegistry,
  normalizeFollowupCandidates,
  normalizeRuntimeMode,
  parseAllowedChannelIds,
  resolveOpenClawApiUrl,
  resolveOpenClawStateDir,
  runOutboundGate,
  validateOpenClawChannelRegistry,
  validateOpenClawResponse,
};
