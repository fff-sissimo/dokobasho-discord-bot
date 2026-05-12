"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_OPENCLAW_TIMEOUT_MS = 180000;
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
  "1201092282254893066": Object.freeze({ name: "はじまりの酒場カテゴリ", type: "chat", status: "verified" }),
  "1098535279549235280": Object.freeze({ name: "配信部屋カテゴリ", type: "chat", status: "verified" }),
  "847492905618505748": Object.freeze({ name: "作業部屋カテゴリ", type: "project", status: "verified" }),
  "1474758754007253062": Object.freeze({ name: "MTG部屋カテゴリ", type: "project", status: "verified" }),
  "843363361121894400": Object.freeze({ name: "連絡ボードカテゴリ", type: "board", status: "verified" }),
  "1094907178671939654": Object.freeze({ name: "妖精さんより", type: "sandbox", status: "verified", category_id: "1201092282254893066" }),
  "840827137916665890": Object.freeze({ name: "はじまりの酒場", type: "chat", status: "verified", category_id: "1201092282254893066" }),
  "849691123920273458": Object.freeze({ name: "おやすみのへや", type: "chat", status: "verified", category_id: "1201092282254893066" }),
  "842361651592560660": Object.freeze({ name: "飯テロ爆撃地", type: "chat", status: "verified", category_id: "1201092282254893066" }),
  "840827137451229210": Object.freeze({ name: "はじまりの酒場", type: "chat", status: "verified", category_id: "1201092282254893066" }),
  "985145703774978059": Object.freeze({ name: "配信部屋", type: "chat", status: "verified", category_id: "1098535279549235280" }),
  "865619584282918982": Object.freeze({ name: "配信部屋", type: "chat", status: "verified", category_id: "1098535279549235280" }),
  "841686630271418429": Object.freeze({ name: "らくがきちょう", type: "creation", status: "verified", category_id: "1201092282254893066" }),
  "847493473350189167": Object.freeze({ name: "作業部屋α", type: "project", status: "verified", category_id: "847492905618505748" }),
  "1484514251811852358": Object.freeze({ name: "作業部屋β", type: "project", status: "verified", category_id: "847492905618505748" }),
  "1484514353360273460": Object.freeze({ name: "作業部屋γ", type: "project", status: "verified", category_id: "847492905618505748" }),
  "847493249517879316": Object.freeze({ name: "作業部屋", type: "project", status: "verified", category_id: "847492905618505748" }),
  "1474758884991172771": Object.freeze({ name: "MTG部屋", type: "project", status: "verified", category_id: "1474758754007253062" }),
  "1474758825193242836": Object.freeze({ name: "mtg部屋", type: "project", status: "verified", category_id: "1474758754007253062" }),
  "1502895720011665439": Object.freeze({ name: "どこ場所に妖精が現れる！", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1501240582687817739": Object.freeze({ name: "404-締切を恨む制作", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1311647968113332275": Object.freeze({ name: "アイデアボード", type: "board", status: "verified", category_id: "843363361121894400" }),
  "1090831888941318236": Object.freeze({ name: "アイデアボード（全体）", type: "board", status: "verified", category_id: "843363361121894400" }),
  "1155374586951634964": Object.freeze({ name: "クエストボード", type: "board", status: "verified", category_id: "843363361121894400" }),
  "1465296404455882860": Object.freeze({ name: "vostok-vol02-general", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1465295987236143319": Object.freeze({ name: "vostok-vol02-pd", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1465296093427531960": Object.freeze({ name: "vostok-vol02-music", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1465296285341847765": Object.freeze({ name: "vostok-vol02-artwork", type: "project", status: "verified", category_id: "843363361121894400" }),
  "1466404431217164288": Object.freeze({ name: "vostok-vol02-qa", type: "project", status: "verified", category_id: "843363361121894400" }),
  "840827137451229208": Object.freeze({ name: "更新・進行状況", type: "ops", status: "known" }),
  "852073750294822922": Object.freeze({ name: "管理用", type: "ops", status: "known" }),
});
const CHANNEL_REGISTRY_STATUSES = new Set(["verified", "pending", "known", "not-connected"]);
const FOLLOWUP_STATUSES = new Set(["open", "checked", "closed"]);
const FOLLOWUP_TEXT_MAX_LENGTH = 200;
const OPENCLAW_CONTEXT_MAX_MESSAGES = 5;
const OPENCLAW_CONTEXT_MAX_CHARS = 1000;
const OPENCLAW_CONTEXT_ENTRY_MAX_CHARS = 300;
const FOLLOWUP_KINDS = new Set([
  "explicit_request",
  "agreed_todo",
  "formal_quest",
  "creation_continuation",
  "test_only",
]);
const FOLLOWUP_BASES = new Set(["explicit_user_request", "agreed_in_thread", "due_followup", "unknown"]);
const DIAGNOSTIC_STRING_KEYS = new Set([
  "request_id",
  "reason_code",
  "attempt_mode",
  "error_code",
  "initial_error_code",
  "last_stage",
  "retry_last_stage",
  "retry_skip_reason",
  "stderr_tail_hash",
  "retry_stderr_tail_hash",
]);
const DIAGNOSTIC_NUMBER_KEYS = new Set([
  "elapsed_ms",
  "first_attempt_timeout_ms",
  "prompt_chars",
  "initial_prompt_chars",
  "first_attempt_elapsed_ms",
  "retry_count",
  "retry_prompt_chars",
  "retry_elapsed_ms",
  "retry_stdout_bytes",
  "retry_stderr_bytes",
  "retry_stderr_line_count",
  "workspace_context_chars",
  "stdout_bytes",
  "stderr_bytes",
  "stderr_line_count",
]);
const SAFE_DIAGNOSTIC_VALUE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const STATE_LOCK_TIMEOUT_MS = 10000;
const STATE_LOCK_STALE_MS = 120000;

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
const parseAllowedCategoryIds = parseAllowedChannelIds;

const toIdSet = (ids) => ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : parseAllowedChannelIds(ids));

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
  const categoryId = String(entry.category_id || entry.parent_category_id || "").trim();
  return Object.freeze({
    name,
    type,
    status,
    ...(categoryId ? { category_id: categoryId } : {}),
  });
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
          const id = String(entry && (entry.id || entry.channel_id || entry.category_id)
            ? entry.id || entry.channel_id || entry.category_id
            : "").trim();
          return [id, entry];
        })
        .filter(([id]) => /^\d+$/.test(id))
    );
  }
  if (Array.isArray(parsed)) {
    return Object.fromEntries(
      parsed
        .map((entry) => {
          const id = String(entry && (entry.id || entry.channel_id || entry.category_id)
            ? entry.id || entry.channel_id || entry.category_id
            : "").trim();
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
  return validateOpenClawChannelRegistry(
    Object.fromEntries(
      Object.entries({
        ...DEFAULT_CHANNEL_REGISTRY,
        ...registrySource,
      }).map(([id, entry]) => [
        id,
        {
          ...(DEFAULT_CHANNEL_REGISTRY[id] || {}),
          ...(entry || {}),
        },
      ])
    )
  );
};

const assertAllowlistIsVerified = ({ allowedChannelIds = [], allowedCategoryIds = [], channelRegistry }) => {
  const unknownOrUnverified = allowedChannelIds.filter((id) => {
    const entry = channelRegistry[id];
    return !entry || entry.status !== "verified";
  });
  if (unknownOrUnverified.length > 0) {
    throw new Error(`invalid OpenClaw channel allowlist: unverified channel ids: ${unknownOrUnverified.join(", ")}`);
  }
  const unknownOrUnverifiedCategories = allowedCategoryIds.filter((id) => {
    const entry = channelRegistry[id];
    return !entry || entry.status !== "verified" || entry.category_id;
  });
  if (unknownOrUnverifiedCategories.length > 0) {
    throw new Error(`invalid OpenClaw category allowlist: unverified category ids: ${unknownOrUnverifiedCategories.join(", ")}`);
  }
};

const assertAllowlistMatchesCanonicalRegistry = ({ allowedChannelIds, channelRegistry, canonicalRegistry = DEFAULT_CHANNEL_REGISTRY }) => {
  const canonicalBlocked = allowedChannelIds.filter((id) => {
    const canonicalEntry = canonicalRegistry[id];
    const runtimeEntry = channelRegistry[id];
    if (!runtimeEntry) return false;
    if (!canonicalEntry) return runtimeEntry.status === "verified";
    return canonicalEntry.status !== "verified" && runtimeEntry.status === "verified";
  });
  if (canonicalBlocked.length > 0) {
    throw new Error(`invalid OpenClaw channel allowlist: canonical registry not verified for channel ids: ${canonicalBlocked.join(", ")}`);
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
  const allowedCategoryIds = parseAllowedCategoryIds(env.FAIRY_OPENCLAW_ALLOWED_CATEGORY_IDS);
  const missing = [];
  if (!apiUrl) missing.push("OPENCLAW_API_BASE_URL");
  if (!apiKey) missing.push("OPENCLAW_API_KEY");
  if (!guildId) missing.push("GUILD_ID");
  if (allowedChannelIds.length === 0 && allowedCategoryIds.length === 0) {
    missing.push("FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS or FAIRY_OPENCLAW_ALLOWED_CATEGORY_IDS");
  }
  if (missing.length > 0) {
    throw new Error(`missing OpenClaw runtime config: ${missing.join(", ")}`);
  }
  const channelRegistry = loadOpenClawChannelRegistry(env);
  assertAllowlistIsVerified({ allowedChannelIds, allowedCategoryIds, channelRegistry });
  assertAllowlistMatchesCanonicalRegistry({ allowedChannelIds: [...allowedChannelIds, ...allowedCategoryIds], channelRegistry });

  return {
    mode,
    apiUrl,
    apiKey,
    guildId,
    allowedChannelIds,
    allowedCategoryIds,
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
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

const isUnsafeFollowupText = (value) => {
  const text = normalizeMessageContent(value);
  if (!text) return false;
  if (text.length > FOLLOWUP_TEXT_MAX_LENGTH) return true;
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (/(?:api[_-]?key|token|secret|password|passwd|key)\s*[:=]\s*[^\s]+/i.test(text)) return true;
  if (/(?:bearer|basic)\s+[a-z0-9._~+/=-]{12,}/i.test(text)) return true;
  if (containsSecretLikeText(text)) return true;
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
  if (containsSecretLikeText(text)) return "";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createOpenClawStateStore = ({
  stateDir = DEFAULT_OPENCLAW_STATE_DIR,
  idFactory = randomUUID,
  now = isoNow,
} = {}) => {
  const rootDir = String(stateDir || DEFAULT_OPENCLAW_STATE_DIR).trim() || DEFAULT_OPENCLAW_STATE_DIR;
  const followupsPath = path.join(rootDir, "followups.json");
  const heartbeatPath = path.join(rootDir, "heartbeat-state.json");
  const lockPath = path.join(rootDir, ".state.lock");
  const lockOwnerPath = path.join(lockPath, "owner.json");
  const reclaimLockPath = path.join(rootDir, ".state.lock.reclaim");

  const withStateLock = async (operation) => {
    const startedAt = Date.now();
    const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.mkdir(rootDir, { recursive: true });

    const readLockCreatedAtMs = async () => {
      try {
        const owner = JSON.parse(await fs.readFile(lockOwnerPath, "utf8"));
        const createdMs = Date.parse(owner && owner.created_at);
        if (Number.isFinite(createdMs)) return createdMs;
      } catch {
        // Fall back to the lock directory timestamp when owner metadata is missing or corrupt.
      }
      try {
        return (await fs.stat(lockPath)).mtimeMs;
      } catch {
        return Date.now();
      }
    };

    const reclaimStaleLock = async () => {
      try {
        await fs.mkdir(reclaimLockPath, { recursive: false });
      } catch (error) {
        if (error && error.code === "EEXIST") return false;
        throw error;
      }
      try {
        const lockAgeMs = Date.now() - (await readLockCreatedAtMs());
        if (lockAgeMs <= STATE_LOCK_STALE_MS) return false;
        await fs.rm(lockPath, { recursive: true, force: true });
        return true;
      } finally {
        await fs.rm(reclaimLockPath, { recursive: true, force: true }).catch(() => {});
      }
    };

    while (true) {
      try {
        await fs.mkdir(lockPath, { recursive: false });
        try {
          await fs.writeFile(lockOwnerPath, JSON.stringify({ owner: ownerToken, created_at: now() }), "utf8");
        } catch (ownerError) {
          await fs.rm(lockPath, { recursive: true, force: true });
          throw ownerError;
        }
        break;
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        if (await reclaimStaleLock()) {
          continue;
        }
        if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
          const timeoutError = new Error("OpenClaw state lock timed out");
          timeoutError.code = "OPENCLAW_STATE_LOCK_TIMEOUT";
          throw timeoutError;
        }
        await sleep(50);
      }
    }
    try {
      return await operation();
    } finally {
      try {
        let owner = null;
        try {
          const ownerText = await fs.readFile(lockOwnerPath, "utf8");
          try {
            owner = JSON.parse(ownerText);
          } catch {
            owner = null;
          }
        } catch (readError) {
          if (!readError || readError.code !== "ENOENT") throw readError;
        }
        if (owner && owner.owner === ownerToken) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
  };

  const readFollowupState = async () => {
    const state = await readJsonFile(followupsPath, createEmptyFollowupState);
    return {
      schema_version: 1,
      followups: Array.isArray(state.followups) ? state.followups : [],
    };
  };

  const normalizeFollowupState = (state) => ({
    schema_version: 1,
    followups: (Array.isArray(state && state.followups) ? state.followups : [])
      .map(normalizePersistedFollowup)
      .filter(Boolean),
  });

  const writeFollowupStateUnlocked = async (state) => {
    const nextState = normalizeFollowupState(state);
    await writeJsonFile(followupsPath, nextState);
    return nextState;
  };

  const writeFollowupState = async (state) => withStateLock(() => writeFollowupStateUnlocked(state));

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
    return withStateLock(async () => {
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
      const nextState = await writeFollowupStateUnlocked({ ...state, followups: [...state.followups, ...additions] });
      return nextState.followups.slice(-additions.length);
    });
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
    return withStateLock(async () => {
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
      await writeFollowupStateUnlocked({ ...state, followups });
      return updated;
    });
  };

  const closeFollowups = async (ids, { closedAt = now(), notes = "" } = {}) => {
    const targetIds = new Set(normalizeFollowupIdList(ids));
    if (targetIds.size === 0) return [];
    return withStateLock(async () => {
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
      await writeFollowupStateUnlocked({ ...state, followups });
      return updated;
    });
  };

  const writeHeartbeatState = async (patch = {}) => withStateLock(async () => {
    const state = normalizeHeartbeatState(patch);
    await writeJsonFile(heartbeatPath, state);
    return state;
  });

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
          const timeoutError = new Error(`OpenClaw request timed out: timeoutMs=${timeoutMs}`);
          timeoutError.code = "OPENCLAW_CLIENT_TIMEOUT";
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const statusError = new Error(`OpenClaw request failed: status=${response.status}`);
        statusError.code = "OPENCLAW_CLIENT_HTTP_STATUS";
        throw statusError;
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
        logger.warn(buildSafeErrorLogFields(error, "DISCORD_TYPING_FAILED"), "[fairy-openclaw] failed to send typing indicator");
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
const trimLineEnd = (line) => line.replace(/[^\S\n]+$/g, "");
const normalizeOutboundMessageContent = (value) =>
  String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(trimLineEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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
  return matches
    ? matches.map((link) => link.replace(/[)\].,、。]+$/u, "")).slice(0, 10)
    : [];
};

const LINK_REQUEST_MAX_URLS = 3;
const LINK_CANDIDATE_MAX_URLS = 3;

const isExplicitLinkReadRequest = (content) => {
  const text = String(content || "");
  if (/(?:投稿案|告知文案|文案|自動投稿せず|扱いだけ確認)/.test(text)) return false;
  return /(?:URL|リンク|ページ|サイト|本文|内容|情報|ここ|そこ|これ|この)/i.test(text) &&
    /(?:拾|読|読み|要約|見て|見れる|見られる|調べ|まとめ|整理|抽出|取れ|取得)/.test(text);
};

const isExplicitLinkHandoffRequest = ({ content, links }) => {
  const text = normalizeMessageContent(content);
  const currentLinks = Array.isArray(links) ? links : [];
  if (currentLinks.length === 0) return false;
  if (/(?:投稿案|告知文案|文案|自動投稿せず|扱いだけ確認)/.test(text)) return false;
  const hasNotionTarget = currentLinks.some(isNotionUrl);
  const hasExternalTarget = currentLinks.some((link) => !isNotionUrl(link));
  if (!hasNotionTarget || !hasExternalTarget) return false;
  return /(?:渡す|共有|対象|こっち|こちら|これ|この|改めて|あらためて)/.test(text);
};

const normalizeSafeRequestUrl = (rawLink) => {
  try {
    const parsed = new URL(String(rawLink || "").replace(/[)\].,、。]+$/u, ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
};

const normalizeSafeRequestUrls = (links, { strict = true, maxUrls = LINK_REQUEST_MAX_URLS } = {}) => {
  const sourceLinks = Array.isArray(links) ? links : [];
  if (sourceLinks.length === 0 || sourceLinks.length > maxUrls) return null;
  const normalizedLinks = [];
  for (const rawLink of sourceLinks) {
    const normalized = normalizeSafeRequestUrl(rawLink);
    if (!normalized) {
      if (strict) return null;
      continue;
    }
    if (!normalizedLinks.includes(normalized)) normalizedLinks.push(normalized);
    if (normalizedLinks.length >= maxUrls) break;
  }
  return normalizedLinks.length > 0 ? normalizedLinks : null;
};

const normalizeExplicitExternalLinkRequest = ({ content, links, channel }) => {
  if (!channel || channel.registered !== true || channel.type === "ops" || channel.type === "unknown") return null;
  if (!isExplicitLinkReadRequest(content) && !isExplicitLinkHandoffRequest({ content, links })) return null;
  const normalizedLinks = normalizeSafeRequestUrls(links);
  if (!normalizedLinks) return null;
  return {
    allowed: true,
    kind: "explicit_external_link_summary",
    urls: normalizedLinks,
  };
};

const isNotionUrl = (value) => {
  try {
    const url = new URL(String(value || "").replace(/[)\].,、。]+$/u, ""));
    const hostname = url.hostname.toLowerCase();
    return hostname === "notion.so" || hostname.endsWith(".notion.so") ||
      hostname === "notion.site" || hostname.endsWith(".notion.site");
  } catch {
    return false;
  }
};

const collectNotionLinks = (content) =>
  collectLinks(content).filter(isNotionUrl).slice(0, 5);

const isPrivateOrLocalHostname = (hostname) => {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (["localhost", "localhost.localdomain"].includes(normalized)) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const parts = normalized.split(".").map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 10 ||
      a === 127 ||
      a === 0 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168;
  }
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:169.254.") ||
    normalized.startsWith("::ffff:172.") ||
    normalized.startsWith("::ffff:192.168.")
  ) return true;
  return false;
};

const hasSecretLikeUrlPart = (url) => {
  const source = `${url.pathname || ""} ${url.search || ""}`;
  return /(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|basic)[=/:]/i.test(source);
};

const normalizeSafeWebTarget = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (String(url.href).length > 500) return null;
    if (isPrivateOrLocalHostname(url.hostname)) return null;
    if (hasSecretLikeUrlPart(url)) return null;
    return {
      url: url.href,
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
};

const collectSafeWebTargets = (links) => {
  const sourceLinks = Array.isArray(links) ? links : collectLinks(links);
  if (sourceLinks.length === 0 || sourceLinks.length > LINK_REQUEST_MAX_URLS) return [];
  return sourceLinks
    .filter((link) => !isNotionUrl(link))
    .map(normalizeSafeWebTarget)
    .filter(Boolean)
    .slice(0, 5);
};

const hasDestructiveNotionRequest = (content) => {
  const text = normalizeMessageContent(content);
  const targetsNotion = /notion/i.test(text) || /ノーション/.test(text) || collectNotionLinks(text).length > 0;
  if (!targetsNotion) return false;
  return /(?:削除|消して|消去|アーカイブ|ゴミ箱|ごみ箱|trash|archive|delete|remove|move|duplicate|複製|移動)/i.test(text);
};

const hasExplicitNotionWriteRequest = (content) => {
  const text = normalizeMessageContent(content);
  if (!/notion/i.test(text) && !/ノーション/.test(text) && collectNotionLinks(text).length === 0) return false;
  if (hasDestructiveNotionRequest(text)) return false;
  return /(?:書いて|書き込んで|保存して|残して|追加して|追記して|更新して|メモして|記録して|作って|作成して)/.test(text);
};

const isDiscordIntentEligibleChannel = (channel) => {
  const type = String(channel && channel.type || "").trim();
  return Boolean(channel && channel.registered === true) && !["ops", "unknown", "dm"].includes(type);
};

const hasDiscordReadVerb = (text) =>
  /(?:読んで|読み|見て|確認して|要約して|まとめて|整理して|取得して|拾って|探して|検索して|一覧|list|fetch|read|summarize)/i.test(text);

const hasCurrentDiscordReadTarget = (text) =>
  /(?:このチャンネル|このスレッド|ここ|この場|直近|履歴|ログ|会話|スレッド|thread|channel|discord)/i.test(text);

const hasExplicitDiscordServerReadRequest = ({ content, explicitTrigger, channel }) => {
  const text = normalizeMessageContent(content);
  if (!explicitTrigger || !isDiscordIntentEligibleChannel(channel)) return false;
  return /(?:サーバー全体|サーバ全体|全チャンネル|チャンネル一覧|全体のチャンネル|(?:この)?discord\s*サーバ(?:ー)?の中身|discord\s*サーバ(?:ー)?内|discord\s*サーバ(?:ー)?を広く|discord\s*サーバ(?:ー)?内を広く|(?:discord|サーバ(?:ー)?|このサーバ(?:ー)?).{0,16}(?:各チャンネル|複数チャンネル)|(?:各チャンネル|複数チャンネル).{0,16}(?:discord|サーバ(?:ー)?|このサーバ(?:ー)?)|server[-\s]?wide|guild[-\s]?wide|list channels)/i.test(text) &&
    hasDiscordReadVerb(text);
};

const hasExplicitDiscordReadRequest = ({ content, explicitTrigger, channel }) => {
  const text = normalizeMessageContent(content);
  if (!explicitTrigger || !isDiscordIntentEligibleChannel(channel)) return false;
  if (hasExplicitDiscordServerReadRequest({ content: text, explicitTrigger, channel })) return true;
  return hasDiscordReadVerb(text) && hasCurrentDiscordReadTarget(text);
};

const hasDiscordWriteDraftOnlyCue = (text) =>
  /(?:投稿案|告知文案|文案|下書き|draft|自動投稿せず|投稿しない|送らない|送信しない|確認だけ|扱いだけ確認|添削|レビュー)/i.test(text);

const hasExplicitDiscordWriteRequest = ({ content, explicitTrigger, channel }) => {
  const text = normalizeMessageContent(content);
  if (!explicitTrigger || !isDiscordIntentEligibleChannel(channel)) return false;
  if (hasDiscordWriteDraftOnlyCue(text)) return false;
  if (/(?:スレッド|thread).*(?:作って|作成して|立てて|開いて|create)/i.test(text)) return true;
  return /(?:(?:ここ|このチャンネル|このスレッド|この場|current channel|current thread).*(?:投稿して|送信して|送って|返信して|post|send)|(?:投稿して|送信して|送って|返信して).*(?:ここ|このチャンネル|このスレッド|この場|current channel|current thread))/i.test(text);
};

const isDiceShortcutRequest = (content) => {
  const text = normalizeMessageContent(content).toLowerCase();
  if (!text) return false;
  return /^(?:dice|ダイス|サイコロ)(?:\s+\d*d\d+(?:\s*(?:を)?\s*\d+\s*回(?:だけ)?)?)?$/.test(text);
};

const hasWorkIntentSignal = (content) => {
  const text = normalizeMessageContent(content);
  if (!text) return false;
  if (collectLinks(text).length > 0) return true;
  if (/notion|ノーション|discord(?:app)?\.com\/channels/i.test(text)) return true;
  return hasExplicitWebRequest(text) ||
    hasExplicitNotionWriteRequest(text) ||
    hasDestructiveNotionRequest(text) ||
    hasExplicitDiscordReadRequest({ content: text, explicitTrigger: true, channel: { registered: true, type: "project" } }) ||
    hasExplicitDiscordWriteRequest({ content: text, explicitTrigger: true, channel: { registered: true, type: "project" } }) ||
    hasProjectWorkIntent(text);
};

const isSimpleGreetingOrShortChat = (content) => {
  const text = normalizeMessageContent(content);
  if (!text || text.length > 40) return false;
  if (hasWorkIntentSignal(text)) return false;
  const compact = text.replace(/[\s!！?？。．、,.〜~ー…]+/g, "").toLowerCase();
  return /^(?:おはよう|おはよ|こんにちは|こんばんは|やっほ|やほ|hi|hello|おつかれさま|お疲れ様|おつ|ありがとう|ありがと|ありがとー|助かった|助かる|了解|りょ|ok|okay|それでok|それでokay|なるほど|いいね|よさそう|草|w|test|テスト)$/.test(compact);
};

const hasExplicitWebRequest = (content) => {
  const text = normalizeMessageContent(content);
  if (/(?:投稿案|告知文案|文案|自動投稿せず|扱いだけ確認)/.test(text)) return false;
  return /(?:拾|読んで|読み|見て|確認して|調べて|調査して|要約して|まとめて|整理して|抽出して|取得して|参照して|使って)/.test(text);
};

const hasProjectWorkIntent = (content) => {
  const text = normalizeMessageContent(content);
  return /(?:整理して|まとめて|作って|作成して|追記して|更新して|書いて|調べて|調査して|実装|レビュー|確認して)/.test(text);
};

const chooseExecutionMode = (payload, { explicitTrigger = false } = {}) => {
  const channelType = String(payload && payload.channel && payload.channel.type || "").trim();
  const content = String(payload && payload.message && payload.message.content || "");
  const notion = payload && payload.context && payload.context.notion ? payload.context.notion : {};
  const web = payload && payload.context && payload.context.web ? payload.context.web : {};
  const discord = payload && payload.context && payload.context.discord ? payload.context.discord : {};
  if (!explicitTrigger) return { mode: "json_contract", reason: "not_explicit_trigger" };
  if (isDiceShortcutRequest(content)) return { mode: "json_contract", reason: "dice_shortcut" };
  if (isSimpleGreetingOrShortChat(content)) return { mode: "json_contract", reason: "short_chat" };
  if (channelType !== "chat" && channelType !== "project") {
    return { mode: "json_contract", reason: `channel_type:${channelType || "unknown"}` };
  }
  if (Array.isArray(notion.links) && notion.links.length > 0) {
    return { mode: "direct_agent", reason: notion.destructive_request ? "notion_destructive_refusal" : "notion_target" };
  }
  if (notion.explicit_write_requested) return { mode: "direct_agent", reason: "notion_write_intent" };
  if (Array.isArray(web.targets) && web.targets.length > 0 && hasExplicitWebRequest(content)) {
    return { mode: "direct_agent", reason: "web_target" };
  }
  if (discord.explicit_write_requested === true) return { mode: "direct_agent", reason: "discord_write_intent" };
  if (discord.explicit_server_read_requested === true) return { mode: "direct_agent", reason: "discord_server_read_intent" };
  if (discord.explicit_read_requested === true) return { mode: "direct_agent", reason: "discord_read_intent" };
  if (
    Array.isArray(payload && payload.message && payload.message.links) &&
    payload.message.links.some((link) => !isNotionUrl(link))
  ) {
    return { mode: "json_contract", reason: "external_link_without_explicit_web" };
  }
  if (channelType === "project" && hasProjectWorkIntent(content)) {
    return { mode: "direct_agent", reason: "project_work" };
  }
  return { mode: "json_contract", reason: "default_contract" };
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

const normalizeContextInput = (contextInput) => {
  if (Array.isArray(contextInput)) return { entries: contextInput, meta: {} };
  if (contextInput && typeof contextInput === "object" && Array.isArray(contextInput.entries)) {
    return {
      entries: contextInput.entries,
      meta: contextInput.meta && typeof contextInput.meta === "object" && !Array.isArray(contextInput.meta)
        ? contextInput.meta
        : {},
    };
  }
  return { entries: [], meta: {} };
};

const normalizeContextEntries = (entries) => {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      message_id: String(entry.message_id || "").trim(),
      author_id: String(entry.author_user_id || entry.author_id || "").trim(),
      author_display_name: String(entry.author_display_name || entry.author_name || "").trim().slice(0, 80),
      author_is_bot: Boolean(entry.author_is_bot),
      channel_id: String(entry.channel_id || "").trim(),
      thread_id: String(entry.thread_id || "").trim(),
      reply_to_message_id: String(entry.reply_to_message_id || entry.reference_message_id || "").trim(),
      context_source: String(entry.context_source || "recent").trim().slice(0, 80),
      content: normalizeMessageContent(entry.content),
      created_at: normalizeIsoTimestamp(entry.created_at || entry.createdAt || entry.createdTimestamp),
    }))
    .filter((entry) => entry.message_id && entry.author_id && entry.content)
    .map((entry) => ({
      message_id: entry.message_id,
      author_id: entry.author_id,
      author_display_name: entry.author_display_name,
      author_is_bot: entry.author_is_bot,
      channel_id: entry.channel_id,
      thread_id: entry.thread_id,
      reply_to_message_id: entry.reply_to_message_id,
      context_source: entry.context_source,
      content: entry.content,
      created_at: entry.created_at,
    }));
};

const isOpenClawOperationalNoise = (content) => {
  const text = normalizeMessageContent(content);
  if (!text) return false;
  return /OpenClaw\s*直接実行に失敗しました|今回は自動送信せず止めました|Context overflow|prompt too large|larger-context model|maximum context length|context length exceeded|token limit|too many tokens/i.test(text);
};

const capContextEntriesForPrompt = (entries, { currentMessageId = "" } = {}) => {
  let totalChars = 0;
  const cappedEntries = [];
  const source = Array.isArray(entries)
    ? entries
      .filter((entry) => entry && entry.message_id !== currentMessageId && !isOpenClawOperationalNoise(entry.content))
      .slice(-OPENCLAW_CONTEXT_MAX_MESSAGES)
      .reverse()
    : [];
  for (const entry of source) {
    const remainingChars = OPENCLAW_CONTEXT_MAX_CHARS - totalChars;
    if (remainingChars <= 0) break;
    const content = String(entry.content || "").slice(0, Math.min(OPENCLAW_CONTEXT_ENTRY_MAX_CHARS, remainingChars));
    totalChars += content.length;
    const cappedEntry = {
      message_id: entry.message_id,
      author_id: entry.author_id,
      content,
      created_at: entry.created_at,
    };
    if (entry.author_display_name) cappedEntry.author_display_name = entry.author_display_name;
    if (entry.author_is_bot === true) cappedEntry.author_is_bot = true;
    if (entry.channel_id) cappedEntry.channel_id = entry.channel_id;
    if (entry.thread_id) cappedEntry.thread_id = entry.thread_id;
    if (entry.reply_to_message_id) cappedEntry.reply_to_message_id = entry.reply_to_message_id;
    if (entry.context_source && entry.context_source !== "recent") cappedEntry.context_source = entry.context_source;
    cappedEntries.push(cappedEntry);
  }
  return cappedEntries.filter((entry) => entry.content).reverse();
};

const collectContextLinkCandidates = ({ content, contextEntries, channel, currentLinks = [] }) => {
  if (!channel || channel.registered !== true || channel.type === "ops" || channel.type === "unknown") return [];
  if (!isExplicitLinkReadRequest(content)) return [];
  if (Array.isArray(currentLinks) && currentLinks.length > 0) return [];
  const candidates = [];
  const seenUrls = new Set();
  const sourceEntries = Array.isArray(contextEntries) ? contextEntries.slice().reverse() : [];
  for (const entry of sourceEntries) {
    if (!entry || isOpenClawOperationalNoise(entry.content)) continue;
    const urls = normalizeSafeRequestUrls(collectLinks(entry.content), {
      strict: false,
      maxUrls: LINK_CANDIDATE_MAX_URLS,
    });
    if (!urls) continue;
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      candidates.push({
        url,
        source: "recent_thread",
        message_id: entry.message_id,
        author_id: entry.author_id,
        created_at: entry.created_at,
      });
      if (candidates.length >= LINK_CANDIDATE_MAX_URLS) return candidates.reverse();
    }
  }
  return candidates.reverse();
};

const normalizeConversationMeta = ({ meta, recentMessages, now }) => {
  const safeMeta = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const targetMessageCount = Number.isFinite(safeMeta.target_message_count)
    ? safeMeta.target_message_count
    : Array.isArray(safeMeta.target_messages)
      ? safeMeta.target_messages.length
      : 0;
  return {
    scope: String(safeMeta.scope || "channel").slice(0, 40),
    source: "discord_history",
    generated_at: now,
    reason: String(safeMeta.reason || "ok").replace(/[^A-Za-z0-9_:-]+/g, "_").slice(0, 64) || "ok",
    error_code: String(safeMeta.error_code || "").replace(/[^A-Za-z0-9_:-]+/g, "_").slice(0, 64),
    requested_messages: Number.isFinite(safeMeta.requested_messages) ? safeMeta.requested_messages : recentMessages.length,
    fetched_messages: Number.isFinite(safeMeta.fetched_messages) ? safeMeta.fetched_messages : recentMessages.length,
    used_messages: recentMessages.length,
    max_chars: Number.isFinite(safeMeta.max_chars) ? safeMeta.max_chars : null,
    total_chars: Number.isFinite(safeMeta.total_chars)
      ? safeMeta.total_chars
      : recentMessages.reduce((sum, entry) => sum + String(entry.content || "").length, 0),
    truncated: safeMeta.truncated === true,
    fetch_batches: Number.isFinite(safeMeta.fetch_batches) ? safeMeta.fetch_batches : 0,
    target_fetches: Number.isFinite(safeMeta.target_fetches) ? safeMeta.target_fetches : 0,
    target_fetch_failures: Number.isFinite(safeMeta.target_fetch_failures) ? safeMeta.target_fetch_failures : 0,
    target_message_count: targetMessageCount,
    included_bot_messages: recentMessages.filter((entry) => entry.author_is_bot === true).length,
    oldest_message_id: String(safeMeta.oldest_message_id || (recentMessages[0] && recentMessages[0].message_id) || ""),
    newest_message_id: String(safeMeta.newest_message_id || (recentMessages[recentMessages.length - 1] && recentMessages[recentMessages.length - 1].message_id) || ""),
  };
};

const calculateActiveThreadAgeMinutes = ({ recentMessages, currentMessageId, currentCreatedAt }) => {
  const currentMs = Date.parse(currentCreatedAt);
  if (!Number.isFinite(currentMs)) return null;

  const previousMs = recentMessages.reduce((latestMs, entry) => {
    if (!entry || entry.message_id === currentMessageId || !entry.created_at) return latestMs;
    if (entry.author_is_bot === true) return latestMs;
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

const resolveChannelPolicy = (channelId, registeredChannel) => {
  const id = String(channelId || "").trim();
  if (id === "1466404431217164288" || (registeredChannel && registeredChannel.name === "vostok-vol02-qa")) {
    return {
      rollout_scope: "vostok_qa_restricted",
      allowed_work: ["surface_unanswered_items"],
      forbidden_work: ["assign_owner", "set_due_date", "set_priority", "make_decisions"],
      instruction:
        "Only surface unanswered-looking QA items. Do not assign owner, due date, or priority; ask humans to decide.",
    };
  }
  return null;
};

const resolveOperationChannelId = (channel, fallbackChannelId) => {
  if (isThreadChannel(channel)) {
    return readSnowflake(channel && channel.parentId, channel && channel.parent && channel.parent.id, fallbackChannelId);
  }
  return readSnowflake(fallbackChannelId, channel && channel.id);
};

const hydrateThreadParentChannel = async ({ channel, client, logger }) => {
  if (!isThreadChannel(channel) || (channel && channel.parent && channel.parent.parentId)) return channel;
  const parentId = readSnowflake(channel && channel.parentId, channel && channel.parent && channel.parent.id);
  const fetchChannel = client && client.channels && typeof client.channels.fetch === "function"
    ? client.channels.fetch.bind(client.channels)
    : null;
  if (!parentId || !fetchChannel) return channel;
  try {
    const parent = await fetchChannel(parentId);
    if (!parent) return channel;
    return Object.assign(Object.create(Object.getPrototypeOf(channel)), channel, {
      parent,
      parentId,
    });
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({
        ...buildSafeErrorLogFields(error, "THREAD_PARENT_FETCH_FAILED"),
        parentChannelId: parentId,
      }, "[fairy-openclaw] failed to fetch thread parent channel");
    }
    return channel;
  }
};

const withResolvedMessageChannel = (message, channel) => {
  if (!message || !channel || message.channel === channel) return message;
  return Object.assign(Object.create(Object.getPrototypeOf(message)), message, { channel });
};

const resolveChannel = ({
  channel,
  channelId,
  allowedChannelIds,
  allowedCategoryIds = new Set(),
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
}) => {
  const metadata = resolveChannelMetadata(channel);
  const rawId = String(channelId || (channel && channel.id) || "").trim();
  const id = metadata.parent_channel_id || rawId;
  const allowedChannels = toIdSet(allowedChannelIds);
  const allowedCategories = toIdSet(allowedCategoryIds);
  const registeredChannel = channelRegistry[id] || null;
  const verifiedByChannel = Boolean(
    registeredChannel && registeredChannel.status === "verified" && allowedChannels.has(id)
  );
  const actualCategoryId = metadata.category_id;
  const registryCategoryId = (registeredChannel && registeredChannel.category_id) || "";
  const resolvedCategoryId = actualCategoryId || (verifiedByChannel ? registryCategoryId : "");
  const registeredCategory = actualCategoryId ? channelRegistry[actualCategoryId] || null : null;
  const verifiedByCategory = Boolean(
    !verifiedByChannel &&
      actualCategoryId &&
      registeredChannel &&
      registeredChannel.status === "verified" &&
      String(registeredChannel.category_id || "") === String(actualCategoryId || "") &&
      registeredCategory &&
      registeredCategory.status === "verified" &&
      allowedCategories.has(actualCategoryId)
  );
  const verified = verifiedByChannel || verifiedByCategory;
  const policy = verified ? resolveChannelPolicy(id, registeredChannel) : null;
  const resolved = {
    id,
    name: String((channel && channel.name) || (registeredChannel && registeredChannel.name) || "").trim(),
    type: verified ? registeredChannel.type : "unknown",
    registered: verified,
    ...metadata,
    category_id: resolvedCategoryId,
    ...(policy ? { policy } : {}),
  };
  if (verifiedByCategory) {
    resolved.gate_source = "category";
  }
  return resolved;
};

const resolveChannelGate = ({
  channel,
  channelId,
  allowedChannelIds,
  allowedCategoryIds = new Set(),
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
}) => {
  const resolvedChannel = resolveChannel({
    channel,
    channelId,
    allowedChannelIds,
    allowedCategoryIds,
    channelRegistry,
  });
  if (resolvedChannel.registered) return { ok: true, reason: "ok", channel: resolvedChannel };
  return { ok: false, reason: "channel_not_verified", channel: resolvedChannel };
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
  allowedCategoryIds = new Set(),
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
  const contextInput = normalizeContextInput(contextEntries);
  const normalizedContextEntries = normalizeContextEntries(contextInput.entries);
  const recentMessages = capContextEntriesForPrompt(normalizedContextEntries, { currentMessageId: messageId });
  const conversationMeta = normalizeConversationMeta({ meta: contextInput.meta, recentMessages, now });
  const resolvedChannel = resolveChannel({
    channel: message && message.channel,
    channelId: channel && channel.id,
    allowedChannelIds,
    allowedCategoryIds,
    channelRegistry,
  });
  const links = collectLinks(content);
  const linkCandidates = collectContextLinkCandidates({
    content: normalizedContent,
    contextEntries: normalizedContextEntries,
    channel: resolvedChannel,
    currentLinks: links,
  });
  const notionLinks = [
    ...collectNotionLinks(content),
    ...linkCandidates.map((candidate) => candidate.url).filter(isNotionUrl),
  ].filter((link, index, source) => source.indexOf(link) === index).slice(0, 5);
  const linkRequest = normalizeExplicitExternalLinkRequest({
    content: normalizedContent,
    links: links.length > 0 ? links : linkCandidates.map((candidate) => candidate.url),
    channel: resolvedChannel,
  });
  const explicitWebRequested = hasExplicitWebRequest(normalizedContent) || Boolean(linkRequest);
  const webTargets = explicitWebRequested
    ? collectSafeWebTargets(links.length > 0 ? links : linkCandidates.map((candidate) => candidate.url))
    : [];
  const explicitDiscordTrigger = Boolean(isReplyToBot || mentionsBot);
  const explicitServerDiscordReadRequested = hasExplicitDiscordServerReadRequest({
    content: normalizedContent,
    explicitTrigger: explicitDiscordTrigger,
    channel: resolvedChannel,
  });
  const explicitDiscordReadRequested = hasExplicitDiscordReadRequest({
    content: normalizedContent,
    explicitTrigger: explicitDiscordTrigger,
    channel: resolvedChannel,
  });
  const explicitDiscordWriteRequested = hasExplicitDiscordWriteRequest({
    content: normalizedContent,
    explicitTrigger: explicitDiscordTrigger,
    channel: resolvedChannel,
  });

  const payload = {
    schema_version: 1,
    source: "discord",
    event_type: eventType,
    received_at: now,
    guild_id: String(guildId || "").trim(),
    channel: resolvedChannel,
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
      links,
      notion_links: notionLinks,
      ...(linkRequest ? { link_request: linkRequest } : {}),
      web_targets: webTargets,
    },
    context: {
      recent_messages: recentMessages,
      link_candidates: linkCandidates,
      conversation: conversationMeta,
      active_thread_age_minutes: calculateActiveThreadAgeMinutes({
        recentMessages: normalizedContextEntries,
        currentMessageId: messageId,
        currentCreatedAt: messageCreatedAt,
      }),
      has_promised_followup: hasExplicitFollowupRequest(normalizedContent),
      matched_followup_ids: [],
      notion: {
        links: notionLinks,
        explicit_write_requested: hasExplicitNotionWriteRequest(normalizedContent),
        destructive_request: hasDestructiveNotionRequest(normalizedContent),
        target_provided: notionLinks.length > 0,
      },
      web: {
        explicit_requested: explicitWebRequested,
        targets: webTargets,
      },
      discord: {
        explicit_read_requested: explicitDiscordReadRequested,
        explicit_write_requested: explicitDiscordWriteRequested,
        explicit_server_read_requested: explicitServerDiscordReadRequested,
      },
    },
    memory: {
      member_ids: [],
      project_ids: [],
      daily_refs: [],
    },
  };
  payload.execution = chooseExecutionMode(payload, {
    explicitTrigger: explicitDiscordTrigger,
  });
  return payload;
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
      logger.warn({
        ...buildSafeErrorLogFields(error, "RUNTIME_STATE_LOAD_FAILED"),
        requestId: payload.request_id,
      }, "[fairy-openclaw] failed to load runtime state");
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
      logger.warn({
        ...buildSafeErrorLogFields(error, "FOLLOWUP_SAVE_FAILED"),
        requestId: payload.request_id,
      }, "[fairy-openclaw] failed to save followup candidates");
    }
    return [];
  }
};

const applyResponseFollowupTransitions = async ({ payload, response, stateStore, logger }) => {
  if (!payload || !response || !stateStore) return { checked: [], closed: [] };
  try {
    const matchedIds = new Set(normalizeFollowupIdList(payload.context && payload.context.matched_followup_ids));
    const checkedIds = normalizeFollowupIdList(response.checked_followup_ids).filter((id) => matchedIds.has(id));
    const closedIds = normalizeFollowupIdList(response.closed_followup_ids).filter((id) => matchedIds.has(id));
    const checked =
      typeof stateStore.markFollowupsChecked === "function"
        ? await stateStore.markFollowupsChecked(checkedIds)
        : [];
    const closed =
      typeof stateStore.closeFollowups === "function" ? await stateStore.closeFollowups(closedIds) : [];
    if ((checked.length > 0 || closed.length > 0) && logger && typeof logger.info === "function") {
      logger.info({
        requestId: payload.request_id,
        channel_id: payload.channel && payload.channel.id,
        channel_type: payload.channel && payload.channel.type,
        checked_count: checked.length,
        checked_ids: checked.map((followup) => normalizeSafeIdentifier(followup && followup.id)).filter(Boolean).slice(0, 20),
        closed_count: closed.length,
        closed_ids: closed.map((followup) => normalizeSafeIdentifier(followup && followup.id)).filter(Boolean).slice(0, 20),
      }, "[fairy-openclaw] followup transitions applied");
    }
    return { checked, closed };
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({
        ...buildSafeErrorLogFields(error, "FOLLOWUP_UPDATE_FAILED"),
        requestId: payload.request_id,
      }, "[fairy-openclaw] failed to update followup state");
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
    body: normalizeOutboundMessageContent(response.body),
    reason: normalizeMessageContent(response.reason),
    requires_approval: Boolean(response.requires_approval),
    approval: response.approval && typeof response.approval === "object" ? response.approval : {},
    diagnostics: normalizeOpenClawDiagnostics(response.diagnostics),
    followup_candidates: normalizeFollowupCandidates(response.followup_candidates),
    checked_followup_ids: normalizeFollowupIdList(response.checked_followup_ids),
    closed_followup_ids: normalizeFollowupIdList(response.closed_followup_ids),
  };
};

const normalizeDiagnosticString = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 80 || !SAFE_DIAGNOSTIC_VALUE_PATTERN.test(text)) return "";
  if (containsExternalLink(text) || containsSecretLikeText(text)) return "";
  return text;
};

const normalizeDiagnosticNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
};

const normalizeOpenClawDiagnostics = (diagnostics) => {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return {};
  const normalized = {};
  for (const key of DIAGNOSTIC_STRING_KEYS) {
    const value = normalizeDiagnosticString(diagnostics[key]);
    if (value) normalized[key] = value;
  }
  for (const key of DIAGNOSTIC_NUMBER_KEYS) {
    const value = normalizeDiagnosticNumber(diagnostics[key]);
    if (value !== null) normalized[key] = value;
  }
  return normalized;
};

const containsBlockedMention = (body) => /@everyone|@here|<@&\d+>/i.test(String(body || ""));
const containsExternalLink = (body) => /https?:\/\/\S+/i.test(String(body || ""));
const containsSecretLikeText = (body) => {
  const text = String(body || "");
  return /(?:^|[\s"'`({\[])(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(text) ||
    /(?:^|[\s"'`({\[])[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(text) ||
    /(?:^|[\s"'`({\[])authorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text) ||
    /(?:^|[\s"'`({\[])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text) ||
    /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})(?=$|[^A-Za-z0-9_-])/i.test(text);
};
const payloadHasInputRisk = (payload) => {
  const message = payload && payload.message ? payload.message : {};
  const content = String(message.content || "");
  if (/@everyone|@here/i.test(content)) return "input_everyone_or_here";
  if (/<@&\d+>/i.test(content)) return "input_role_mention";
  if (message.mentions_everyone) return "input_everyone_or_here";
  if (Array.isArray(message.role_mentions) && message.role_mentions.length > 0) return "input_role_mention";
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return "input_attachment";
  if (
    Array.isArray(message.links) &&
    message.links.length > 0
  ) {
    const notionLinks = new Set((Array.isArray(message.notion_links) ? message.notion_links : []).map(String));
    const nonNotionLinks = message.links.filter((link) => !notionLinks.has(String(link)) && !isNotionUrl(link));
    if (nonNotionLinks.length > 0) {
      const webTargets = new Set((Array.isArray(message.web_targets) ? message.web_targets : []).map((target) => String(target && target.url || "")));
      const normalizedTargets = nonNotionLinks.map(normalizeSafeWebTarget);
      const hasUnsafeUrl = normalizedTargets.some((target) => !target);
      if (hasUnsafeUrl) return "input_unsafe_url";
      const directMode = payload && payload.execution && payload.execution.mode === "direct_agent";
      const allTargetsForwarded = normalizedTargets.every((target) => webTargets.has(target.url));
      if (directMode && !allTargetsForwarded) return "input_unsafe_url";
      if (!directMode) return "input_external_link";
    }
  }
  return "";
};
const runInputRiskGate = (payload) => {
  const reason = payloadHasInputRisk(payload);
  return reason ? { ok: false, reason } : { ok: true, reason: "ok" };
};

const isPayloadChannelAllowed = ({ channelId, allowedChannelIds, allowedCategoryIds = new Set(), payload, channelMetadata }) => {
  const allowedChannels = toIdSet(allowedChannelIds);
  const allowedCategories = toIdSet(allowedCategoryIds);
  if (allowedChannels.has(String(channelId || ""))) return true;
  const metadata = channelMetadata || (payload && payload.channel) || {};
  return Boolean(
    metadata &&
      metadata.registered === true &&
      metadata.gate_source === "category" &&
      allowedCategories.has(String(metadata.category_id || ""))
  );
};

const runOutboundGate = ({
  response,
  channelId,
  allowedChannelIds,
  allowedCategoryIds = new Set(),
  payload,
  channelMetadata,
}) => {
  if (!isPayloadChannelAllowed({ channelId, allowedChannelIds, allowedCategoryIds, payload, channelMetadata })) {
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

const buildDiagnosticsSummary = (diagnostics = {}) => {
  const parts = [];
  for (const key of [
    "request_id",
    "reason_code",
    "attempt_mode",
    "elapsed_ms",
    "first_attempt_timeout_ms",
    "prompt_chars",
    "initial_prompt_chars",
    "first_attempt_elapsed_ms",
    "retry_count",
    "retry_prompt_chars",
    "retry_elapsed_ms",
    "retry_stdout_bytes",
    "retry_stderr_bytes",
    "retry_stderr_line_count",
    "workspace_context_chars",
    "stdout_bytes",
    "stderr_bytes",
    "stderr_line_count",
    "error_code",
    "initial_error_code",
    "last_stage",
    "retry_last_stage",
    "retry_skip_reason",
    "stderr_tail_hash",
    "retry_stderr_tail_hash",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(diagnostics, key)) continue;
    parts.push(`${key}=${diagnostics[key]}`);
  }
  return parts.join(" ");
};

const buildResponseFailureDiagnostics = ({ payload, response }) => {
  const diagnostics = normalizeOpenClawDiagnostics(response && response.diagnostics);
  if (payload && payload.request_id && !diagnostics.request_id) {
    diagnostics.request_id = normalizeDiagnosticString(payload.request_id);
  }
  if (response && response.reason && !diagnostics.reason_code) {
    diagnostics.reason_code = normalizeDiagnosticString(response.reason);
  }
  return diagnostics;
};

const normalizeClientErrorCode = (error) => {
  if (error && typeof error === "object") {
    const code = normalizeDiagnosticString(error.code);
    if (code) return code;
    if (error.name === "AbortError") return "ABORT_ERROR";
  }
  return "CLIENT_ERROR";
};

const buildSafeErrorLogFields = (error, fallback = "OPENCLAW_CLIENT_ERROR") => ({
  error_code: normalizeClientErrorCode(error) || normalizeDiagnosticString(fallback) || "CLIENT_ERROR",
});

const buildClientFailureDiagnostics = ({ payload, error }) => {
  const diagnostics = {
    reason_code: "client_error",
    error_code: normalizeClientErrorCode(error),
  };
  if (payload && payload.request_id) {
    diagnostics.request_id = normalizeDiagnosticString(payload.request_id);
  }
  return diagnostics;
};

const buildSafeFailureMessage = (diagnostics) => {
  const summary = buildDiagnosticsSummary(normalizeOpenClawDiagnostics(diagnostics));
  const base = "-# うまく返せませんでした。少し時間をおいて、もう一度呼んでください。";
  return summary ? `${base}\n-# 詳細: ${summary}` : base;
};
const buildGateBlockedMessage = (reason) => {
  const normalizedReason = normalizeDiagnosticString(reason);
  const base = "-# 今回は自動送信せず止めました。";
  return normalizedReason ? `${base}\n-# 詳細: reason_code=${normalizedReason}` : base;
};
const OPENCLAW_FAILURE_OBSERVE_REASONS = new Set([
  "OPENCLAW_TIMEOUT",
  "OPENCLAW_EXIT",
  "OPENCLAW_SESSION_CLEANUP_FAILED",
  "context_overflow",
  "openclaw_execution_failed",
  "openclaw_error_text",
  "invalid_openclaw_response",
  "invalid_openclaw_action",
  "secret_like_output",
  "unparseable_openclaw_output",
]);
const isOpenClawFailureObserve = (response) =>
  response &&
  response.action === "observe" &&
  OPENCLAW_FAILURE_OBSERVE_REASONS.has(String(response.reason || ""));
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
  allowedCategoryIds = [],
  guildId,
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
  stateStore,
  contextEntriesSource,
  requestIdFactory = randomUUID,
  logger,
}) => {
  const allowed = new Set(allowedChannelIds);
  const allowedCategories = new Set(allowedCategoryIds);
  return async (interaction) => {
    if (!interaction.isChatInputCommand || !interaction.isChatInputCommand() || interaction.commandName !== "fairy") {
      return { handled: false };
    }
    if (String(interaction.guildId || "") !== String(guildId)) {
      const gate = { ok: false, reason: "guild_mismatch" };
      await interaction.reply({ content: buildGateBlockedMessage(gate.reason), ephemeral: true, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, gate };
    }
    const operationChannelId = resolveOperationChannelId(interaction.channel, interaction.channelId);
    const resolvedInteractionChannel = await hydrateThreadParentChannel({
      channel: interaction.channel,
      client: interaction.client,
      logger,
    });
    const channelGate = resolveChannelGate({
      channel: resolvedInteractionChannel,
      channelId: operationChannelId,
      allowedChannelIds: allowed,
      allowedCategoryIds: allowedCategories,
      channelRegistry,
    });
    if (!channelGate.ok) {
      const gate = { ok: false, reason: channelGate.reason };
      await interaction.reply({ content: buildGateBlockedMessage(gate.reason), ephemeral: true, allowedMentions: SAFE_ALLOWED_MENTIONS });
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
        channel: resolvedInteractionChannel,
        createdAt: new Date(),
      },
      content,
      mentionsBot: true,
      allowedChannelIds: allowed,
      allowedCategoryIds: allowedCategories,
      channelRegistry,
      contextEntries: typeof contextEntriesSource === "function"
        ? await contextEntriesSource({
            interaction,
            content,
            operationChannelId,
            allowedChannelIds: allowed,
            allowedCategoryIds: allowedCategories,
            channelRegistry,
          })
        : [],
    });
    payload.request_id = requestIdFactory();
    const inputGate = runInputRiskGate(payload);
    if (!inputGate.ok) {
      await interaction.editReply({ content: buildGateBlockedMessage(inputGate.reason), allowedMentions: SAFE_ALLOWED_MENTIONS });
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
        allowedCategoryIds: allowedCategories,
        payload,
        channelMetadata: payload.channel,
      });
      if (!gate.ok) {
        if (isOpenClawFailureObserve(response)) {
          await interaction.editReply({
            content: buildSafeFailureMessage(buildResponseFailureDiagnostics({ payload, response })),
            allowedMentions: SAFE_ALLOWED_MENTIONS,
          });
          return { handled: true, requestId: payload.request_id, payload, response, gate };
        }
        await interaction.editReply({ content: buildGateBlockedMessage(gate.reason), allowedMentions: SAFE_ALLOWED_MENTIONS });
        return { handled: true, requestId: payload.request_id, payload, response, gate };
      }
      await interaction.editReply({ content: response.body, allowedMentions: SAFE_ALLOWED_MENTIONS });
      return { handled: true, requestId: payload.request_id, payload, response, gate };
    } catch (error) {
      if (logger) {
        logger.warn({
          ...buildSafeErrorLogFields(error),
          requestId: payload.request_id,
        }, "[fairy-openclaw] interaction failed");
      }
      await interaction.editReply({
        content: buildSafeFailureMessage(buildClientFailureDiagnostics({ payload, error })),
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
      return { handled: true, requestId: payload.request_id, payload, error: normalizeClientErrorCode(error) };
    }
  };
};

const createOpenClawMessageHandler = ({
  openClawClient,
  allowedChannelIds,
  allowedCategoryIds = [],
  guildId,
  channelRegistry = DEFAULT_CHANNEL_REGISTRY,
  stateStore,
  contextEntriesSource,
  requestIdFactory = randomUUID,
  logger,
}) => {
  const allowed = new Set(allowedChannelIds);
  const allowedCategories = new Set(allowedCategoryIds);
  return async (message, runtimeOptions = {}) => {
    if (!message || !message.content || !message.author || message.author.bot) {
      return { handled: false };
    }
    const channelId = String(message.channelId || (message.channel && message.channel.id) || "");
    const operationChannelId = resolveOperationChannelId(message.channel, channelId);
    if (String(message.guildId || "") !== String(guildId)) {
      return { handled: false, gate: { ok: false, reason: "guild_mismatch" } };
    }
    const resolvedMessageChannel = await hydrateThreadParentChannel({
      channel: message.channel,
      client: message.client,
      logger,
    });
    const channelGate = resolveChannelGate({
      channel: resolvedMessageChannel,
      channelId: operationChannelId,
      allowedChannelIds: allowed,
      allowedCategoryIds: allowedCategories,
      channelRegistry,
    });
    if (!channelGate.ok) {
      return { handled: false, gate: { ok: false, reason: channelGate.reason } };
    }
    const content = stripBotMention(message.content, message.client && message.client.user && message.client.user.id);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: message.guildId,
      channel: { id: operationChannelId, name: message.channel && message.channel.name },
      message: withResolvedMessageChannel(message, resolvedMessageChannel),
      content,
      isReplyToBot: runtimeOptions.messageTriggerSource === "reply",
      mentionsBot: runtimeOptions.messageTriggerSource !== "reply",
      allowedChannelIds: allowed,
      allowedCategoryIds: allowedCategories,
      channelRegistry,
      contextEntries: typeof contextEntriesSource === "function"
        ? await contextEntriesSource({
            message,
            content,
            operationChannelId,
            allowedChannelIds: allowed,
            allowedCategoryIds: allowedCategories,
            channelRegistry,
          })
        : [],
    });
    payload.request_id = requestIdFactory();
    const inputGate = runInputRiskGate(payload);
    if (!inputGate.ok) {
      if (isExplicitMessageTrigger(runtimeOptions.messageTriggerSource)) {
        const sentMessage = await message.reply({
          content: buildGateBlockedMessage(inputGate.reason),
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
        allowedCategoryIds: allowedCategories,
        payload,
        channelMetadata: payload.channel,
      });
      if (!gate.ok) {
        if (isOpenClawFailureObserve(response) && isExplicitMessageTrigger(runtimeOptions.messageTriggerSource)) {
          const sentMessage = await message.reply({
            content: buildSafeFailureMessage(buildResponseFailureDiagnostics({ payload, response })),
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
        if (
          shouldReplyWithGateBlockedMessage(gate.reason) &&
          isExplicitMessageTrigger(runtimeOptions.messageTriggerSource)
        ) {
          const sentMessage = await message.reply({
            content: buildGateBlockedMessage(gate.reason),
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
      if (logger) {
        logger.warn({
          ...buildSafeErrorLogFields(error),
          requestId: payload.request_id,
        }, "[fairy-openclaw] message failed");
      }
      const sentMessage = await message.reply({
        content: buildSafeFailureMessage(buildClientFailureDiagnostics({ payload, error })),
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
      return {
        handled: true,
        requestId: payload.request_id,
        payload,
        error: normalizeClientErrorCode(error),
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
