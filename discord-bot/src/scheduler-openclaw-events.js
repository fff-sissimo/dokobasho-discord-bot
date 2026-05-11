"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  createOpenClawClient,
  createOpenClawStateStore,
  resolveOpenClawApiUrl,
  resolveOpenClawStateDir,
} = require("./fairy-openclaw-runtime");

const DEFAULT_HEARTBEAT_CRON = "*/15 * * * *";
const DEFAULT_DREAMING_CRON = "17 3 * * *";
const DEFAULT_TIMEZONE = "Asia/Tokyo";
const REQUEST_AUDIT_MAX_LINES = 500;
const SAFE_STRING_MAX_LENGTH = 240;

const DISABLED_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const DENIED_RESPONSE_KEYS = /(?:^|_)(?:raw|contents?|bod(?:y|ies)|messages?|texts?|urls?|links?|tokens?|secrets?|authorization|api[_-]?keys?|passwords?)(?:_|$)/i;
const SECRET_LIKE_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s]+|(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|(?:sk-proj-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,})/i;

const nowIso = () => new Date().toISOString();

const buildSafeErrorLogFields = (error, fallbackCode) => {
  const rawCode = String(error && (error.code || error.name) || fallbackCode || "SCHEDULER_OPENCLAW_ERROR");
  const errorCode = rawCode.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) || "SCHEDULER_OPENCLAW_ERROR";
  return { error_code: errorCode };
};

const parseEnabledFlag = (raw, fallback = true) => {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return fallback;
  if (DISABLED_VALUES.has(value)) return false;
  if (ENABLED_VALUES.has(value)) return true;
  return fallback;
};

const normalizeSafeIdentifier = (value, fallback = "unknown") => {
  const text = String(value || "");
  if (SECRET_LIKE_PATTERN.test(text) || /https?:\/\/\S+|@everyone|@here|<@!?&?\d+>/i.test(text)) {
    return fallback;
  }
  const normalized = text
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 96);
  return normalized || fallback;
};

const normalizeSafeString = (value, maxLength = SAFE_STRING_MAX_LENGTH) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/@everyone|@here|<@!?&?\d+>|https?:\/\/\S+/i.test(text)) return "";
  if (SECRET_LIKE_PATTERN.test(text)) return "";
  return text.slice(0, maxLength);
};

const deriveAutonomyUrl = (discordRespondUrl, eventName) => {
  const parsed = new URL(discordRespondUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  if (basePath !== "/discord/respond") {
    throw new Error("invalid OpenClaw autonomy config: OPENCLAW_API_BASE_URL must end with /discord/respond");
  }
  parsed.pathname = `/internal/autonomy/${eventName}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const createSchedulerOpenClawEventsConfig = (env = process.env) => {
  const mode = String(env.FAIRY_RUNTIME_MODE || "n8n").trim().toLowerCase();
  const apiKey = String(env.OPENCLAW_API_KEY || "").trim();
  const hasBaseUrl = Boolean(String(env.OPENCLAW_API_BASE_URL || env.OPENCLAW_API_URL || "").trim());
  const enabled = mode === "openclaw" && hasBaseUrl && Boolean(apiKey);

  if (!enabled) {
    return {
      enabled: false,
      reason: "missing_openclaw_scheduler_config",
      heartbeatEnabled: false,
      dreamingEnabled: false,
    };
  }

  const discordRespondUrl = resolveOpenClawApiUrl(env);
  const timezone = String(env.DEFAULT_TZ || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;

  return {
    enabled: true,
    hasApiKey: true,
    heartbeatUrl: deriveAutonomyUrl(discordRespondUrl, "heartbeat"),
    dreamingUrl: deriveAutonomyUrl(discordRespondUrl, "dreaming"),
    timeoutMs: Number.isFinite(Number(env.OPENCLAW_API_TIMEOUT_MS)) && Number(env.OPENCLAW_API_TIMEOUT_MS) > 0
      ? Math.floor(Number(env.OPENCLAW_API_TIMEOUT_MS))
      : 85000,
    stateDir: resolveOpenClawStateDir(env),
    requestAuditPath: String(env.OPENCLAW_REQUEST_AUDIT_PATH || "").trim(),
    timezone,
    heartbeatEnabled: parseEnabledFlag(env.OPENCLAW_AUTONOMY_HEARTBEAT_ENABLED, true),
    heartbeatCron: String(env.OPENCLAW_AUTONOMY_HEARTBEAT_CRON || DEFAULT_HEARTBEAT_CRON).trim() || DEFAULT_HEARTBEAT_CRON,
    dreamingEnabled: parseEnabledFlag(env.OPENCLAW_AUTONOMY_DREAMING_ENABLED, true),
    dreamingCron: String(env.OPENCLAW_AUTONOMY_DREAMING_CRON || DEFAULT_DREAMING_CRON).trim() || DEFAULT_DREAMING_CRON,
  };
};

const createEventLock = () => {
  let inFlight = false;
  return async (fn) => {
    if (inFlight) return { skipped: true, reason: "in_flight" };
    inFlight = true;
    try {
      return await fn();
    } finally {
      inFlight = false;
    }
  };
};

const appendAuditRecord = async ({ stateDir, record }) => {
  const auditPath = path.join(stateDir, "autonomy-audit.jsonl");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8");
};

const writeAtomicJsonFile = async (filePath, value) => {
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

const sanitizeFollowupForPayload = (followup) => ({
  id: normalizeSafeIdentifier(followup && followup.id, ""),
  summary: normalizeSafeString(followup && followup.summary, 200),
  channel: {
    id: String(followup && followup.channel_id || "").replace(/[^\d]/g, "").slice(0, 32),
    type: normalizeSafeIdentifier(followup && followup.channel_type, "unknown"),
  },
  kind: normalizeSafeIdentifier(followup && followup.kind, "unknown"),
  due_at: normalizeSafeString(followup && followup.due_at, 40),
});

const countFollowups = (followups, currentIso) => {
  const currentMs = Date.parse(currentIso);
  return (Array.isArray(followups) ? followups : []).reduce((counts, followup) => {
    const status = String(followup && followup.status || "unknown");
    counts.total_count += 1;
    if (status === "open") {
      counts.open_count += 1;
      const dueMs = Date.parse(followup.due_at);
      if (Number.isFinite(currentMs) && Number.isFinite(dueMs) && dueMs <= currentMs) {
        counts.due_count += 1;
      }
    } else if (status === "checked") {
      counts.checked_count += 1;
    } else if (status === "closed") {
      counts.closed_count += 1;
    }
    return counts;
  }, { total_count: 0, open_count: 0, due_count: 0, checked_count: 0, closed_count: 0 });
};

const increment = (target, key) => {
  const safeKey = normalizeSafeIdentifier(key, "unknown");
  target[safeKey] = (target[safeKey] || 0) + 1;
};

const aggregateRequestAudit = async (stateDir, requestAuditPath = "") => {
  const auditPath = String(requestAuditPath || "").trim() || path.join(stateDir, "request-audit.jsonl");
  let contents;
  try {
    contents = await fs.readFile(auditPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        total_count: 0,
        by_action: {},
        by_channel_type: {},
        by_execution_mode: {},
        by_outcome: {},
        recent_error_codes: [],
      };
    }
    throw error;
  }

  const lines = contents.split(/\r?\n/).filter(Boolean).slice(-REQUEST_AUDIT_MAX_LINES);
  const aggregate = {
    total_count: 0,
    by_action: {},
    by_channel_type: {},
    by_execution_mode: {},
    by_outcome: {},
    recent_error_codes: [],
  };
  const recentErrors = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    aggregate.total_count += 1;
    increment(aggregate.by_action, entry.action);
    increment(aggregate.by_channel_type, entry.channel_type || (entry.channel && entry.channel.type));
    increment(aggregate.by_execution_mode, entry.execution_mode || (entry.execution && entry.execution.mode));
    increment(aggregate.by_outcome, entry.outcome || entry.status || "unknown");
    const errorCode = normalizeSafeIdentifier(entry.error_code || entry.errorCode || "", "");
    if (errorCode) recentErrors.push(errorCode);
  }
  aggregate.recent_error_codes = recentErrors.slice(-20);
  return aggregate;
};

const sanitizeJsonForDreamFile = (value, depth = 0) => {
  if (depth > 8) return undefined;
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return normalizeSafeString(value, 2000);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonForDreamFile(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;
  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (DENIED_RESPONSE_KEYS.test(key)) continue;
    const safeValue = sanitizeJsonForDreamFile(nestedValue, depth + 1);
    if (safeValue !== undefined) sanitized[normalizeSafeIdentifier(key)] = safeValue;
  }
  return sanitized;
};

const formatDateInTimezone = (date, timezone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const writeDreamFile = async ({ stateDir, timezone, currentDate, payload, response }) => {
  const dreamDate = formatDateInTimezone(currentDate, timezone);
  const dreamsDir = path.join(stateDir, "dreams");
  const dreamPath = path.join(dreamsDir, `${dreamDate}.json`);
  const record = {
    schema_version: 1,
    generated_at: currentDate.toISOString(),
    request: sanitizeJsonForDreamFile(payload),
    response: sanitizeJsonForDreamFile(response),
  };
  await writeAtomicJsonFile(dreamPath, record);
  return dreamPath;
};

const createSchedulerOpenClawEventsRunner = ({
  env = process.env,
  logger = console,
  fetchImpl = fetch,
  stateStore,
  now = nowIso,
} = {}) => {
  const config = createSchedulerOpenClawEventsConfig(env);
  const apiKey = String(env.OPENCLAW_API_KEY || "").trim();
  const store = stateStore || (config.enabled ? createOpenClawStateStore({ stateDir: config.stateDir, now }) : null);
  const heartbeatClient = config.enabled
    ? createOpenClawClient({ apiUrl: config.heartbeatUrl, apiKey, timeoutMs: config.timeoutMs, fetchImpl })
    : null;
  const dreamingClient = config.enabled
    ? createOpenClawClient({ apiUrl: config.dreamingUrl, apiKey, timeoutMs: config.timeoutMs, fetchImpl })
    : null;
  const heartbeatLock = createEventLock();
  const dreamingLock = createEventLock();

  const audit = async (record) => {
    if (!config.enabled) return;
    try {
      await appendAuditRecord({ stateDir: config.stateDir, record });
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn(buildSafeErrorLogFields(error, "AUTONOMY_AUDIT_WRITE_FAILED"), "[scheduler-openclaw] failed to write autonomy audit");
      }
    }
  };

  const runHeartbeat = async () => {
    if (!config.enabled || !config.heartbeatEnabled) return { status: "disabled" };
    return heartbeatLock(async () => {
      const currentIso = now();
      const dueFollowups = await store.listDueOpenFollowups({ now: currentIso });
      if (dueFollowups.length === 0) {
        await store.writeHeartbeatState({ lastChecks: { followups: currentIso } });
        await audit({
          ts: currentIso,
          event: "heartbeat",
          status: "no_op",
          due_followup_count: 0,
        });
        return { status: "no_op", dueFollowupCount: 0 };
      }

      const payload = {
        schema_version: 1,
        source: "discord-scheduler",
        event: "heartbeat",
        received_at: currentIso,
        followup_count: dueFollowups.length,
        followups: dueFollowups.map(sanitizeFollowupForPayload).filter((followup) => followup.id && followup.summary),
      };
      const response = await heartbeatClient.execute(payload);
      const allowedFollowupIds = new Set(payload.followups.map((followup) => followup.id));
      const checkedIds = (Array.isArray(response && response.checked_followup_ids) ? response.checked_followup_ids : [])
        .map((id) => normalizeSafeIdentifier(id, ""))
        .filter((id) => id && allowedFollowupIds.has(id));
      const closedIds = (Array.isArray(response && response.closed_followup_ids) ? response.closed_followup_ids : [])
        .map((id) => normalizeSafeIdentifier(id, ""))
        .filter((id) => id && allowedFollowupIds.has(id));
      const checked =
        typeof store.markFollowupsChecked === "function" && checkedIds.length > 0
          ? await store.markFollowupsChecked(checkedIds)
          : [];
      const closed =
        typeof store.closeFollowups === "function" && closedIds.length > 0
          ? await store.closeFollowups(closedIds)
          : [];
      await store.writeHeartbeatState({ lastChecks: { followups: currentIso } });
      await audit({
        ts: currentIso,
        event: "heartbeat",
        status: "sent",
        due_followup_count: dueFollowups.length,
        checked_count: checked.length,
        closed_count: closed.length,
      });
      return { status: "sent", dueFollowupCount: dueFollowups.length, checkedCount: checked.length, closedCount: closed.length, response };
    });
  };

  const runDreaming = async () => {
    if (!config.enabled || !config.dreamingEnabled) return { status: "disabled" };
    return dreamingLock(async () => {
      const currentIso = now();
      const currentDate = new Date(currentIso);
      const followupState = await store.readFollowupState();
      const payload = {
        schema_version: 1,
        source: "discord-scheduler",
        event: "dreaming",
        received_at: currentIso,
        request_audit: await aggregateRequestAudit(config.stateDir, config.requestAuditPath),
        followups: countFollowups(followupState.followups, currentIso),
      };
      const response = await dreamingClient.execute(payload);
      const dreamPath = await writeDreamFile({
        stateDir: config.stateDir,
        timezone: config.timezone,
        currentDate,
        payload,
        response,
      });
      await audit({
        ts: currentIso,
        event: "dreaming",
        status: "saved",
        dream_path: dreamPath,
        followup_total_count: payload.followups.total_count,
      });
      return { status: "saved", dreamPath, response };
    });
  };

  return {
    config,
    runHeartbeat,
    runDreaming,
  };
};

const scheduleOpenClawAutonomyEvents = ({ cron, logger = console, env = process.env, runner } = {}) => {
  const activeRunner = runner || createSchedulerOpenClawEventsRunner({ env, logger });
  const { config } = activeRunner;
  if (!config.enabled) {
    if (logger && typeof logger.info === "function") {
      logger.info({ reason: config.reason }, "[scheduler-openclaw] autonomy runners disabled");
    }
    return { enabled: false, tasks: [], runner: activeRunner };
  }
  if (!cron || typeof cron.schedule !== "function") {
    throw new Error("missing node-cron scheduler");
  }

  const tasks = [];
  if (config.heartbeatEnabled) {
    tasks.push(cron.schedule(config.heartbeatCron, () => {
      activeRunner.runHeartbeat().catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error(buildSafeErrorLogFields(error, "AUTONOMY_HEARTBEAT_FAILED"), "[scheduler-openclaw] heartbeat failed");
        }
      });
    }, { timezone: config.timezone, name: "openclaw-autonomy-heartbeat" }));
  }
  if (config.dreamingEnabled) {
    tasks.push(cron.schedule(config.dreamingCron, () => {
      activeRunner.runDreaming().catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error(buildSafeErrorLogFields(error, "AUTONOMY_DREAMING_FAILED"), "[scheduler-openclaw] dreaming failed");
        }
      });
    }, { timezone: config.timezone, name: "openclaw-autonomy-dreaming" }));
  }
  if (logger && typeof logger.info === "function") {
    logger.info({
      heartbeatEnabled: config.heartbeatEnabled,
      heartbeatCron: config.heartbeatCron,
      dreamingEnabled: config.dreamingEnabled,
      dreamingCron: config.dreamingCron,
      timezone: config.timezone,
    }, "[scheduler-openclaw] autonomy runners scheduled");
  }
  return { enabled: true, tasks, runner: activeRunner };
};

module.exports = {
  DEFAULT_DREAMING_CRON,
  DEFAULT_HEARTBEAT_CRON,
  DEFAULT_TIMEZONE,
  aggregateRequestAudit,
  createSchedulerOpenClawEventsConfig,
  createSchedulerOpenClawEventsRunner,
  deriveAutonomyUrl,
  scheduleOpenClawAutonomyEvents,
  sanitizeFollowupForPayload,
};
