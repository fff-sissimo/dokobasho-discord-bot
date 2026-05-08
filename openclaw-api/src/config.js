"use strict";

const DEFAULT_PROMPT_FILES = [
  "RUNTIME_PROMPT.md",
  "IDENTITY.md",
  "SOUL.md",
  "MEMORY.md",
];
const DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS = 4000;
const DEFAULT_RETRY_MIN_TIMEOUT_MS = 60000;
const DEFAULT_FIRST_ATTEMPT_TIMEOUT_MS = 75000;
const DEFAULT_KILL_GRACE_MS = 10000;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
};

const parsePromptFiles = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const loadConfig = (env = process.env) => {
  const apiKey = String(env.OPENCLAW_API_KEY || "").trim();
  const workspaceDir = String(env.OPENCLAW_WORKSPACE_DIR || "/opt/dokobasho/openclaw").trim();
  const agentMode = String(env.OPENCLAW_AGENT_MODE || "local").trim().toLowerCase();

  return {
    host: String(env.OPENCLAW_API_HOST || "0.0.0.0").trim(),
    port: parsePositiveInt(env.OPENCLAW_API_PORT, 8788),
    apiKey,
    workspaceDir,
    command: String(env.OPENCLAW_COMMAND || "openclaw").trim(),
    agentMode: agentMode === "gateway" ? "gateway" : "local",
    agentId: String(env.OPENCLAW_AGENT_ID || "").trim(),
    sessionId: String(env.OPENCLAW_AGENT_SESSION_ID || "dokobasho-fairy-discord-v1").trim(),
    sessionScope: String(env.OPENCLAW_AGENT_SESSION_SCOPE || "request").trim().toLowerCase() === "fixed"
      ? "fixed"
      : "request",
    thinking: String(env.OPENCLAW_AGENT_THINKING || "low").trim(),
    timeoutSeconds: parsePositiveInt(env.OPENCLAW_AGENT_TIMEOUT_SECONDS, 120),
    requestTimeoutMs: parsePositiveInt(env.OPENCLAW_REQUEST_TIMEOUT_MS, 160000),
    firstAttemptTimeoutMs: parsePositiveInt(
      env.OPENCLAW_FIRST_ATTEMPT_TIMEOUT_MS,
      DEFAULT_FIRST_ATTEMPT_TIMEOUT_MS
    ),
    retryMinTimeoutMs: parsePositiveInt(env.OPENCLAW_RETRY_MIN_TIMEOUT_MS, DEFAULT_RETRY_MIN_TIMEOUT_MS),
    killGraceMs: parsePositiveInt(env.OPENCLAW_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS),
    traceLogs: parseBoolean(env.OPENCLAW_TRACE_LOGS, false),
    cleanupSessionState: parseBoolean(env.OPENCLAW_CLEANUP_SESSION_STATE, true),
    maxBodyBytes: parsePositiveInt(env.OPENCLAW_API_MAX_BODY_BYTES, 65536),
    maxWorkspaceContextChars: parsePositiveInt(
      env.OPENCLAW_WORKSPACE_CONTEXT_MAX_CHARS,
      DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS
    ),
    promptFiles: parsePromptFiles(env.OPENCLAW_PROMPT_FILES).length > 0
      ? parsePromptFiles(env.OPENCLAW_PROMPT_FILES)
      : DEFAULT_PROMPT_FILES,
    notion: {
      enabled: parseBoolean(env.OPENCLAW_NOTION_ENABLED, false),
      token: String(env.OPENCLAW_NOTION_TOKEN || env.NOTION_TOKEN || env.NOTION_API_KEY || "").trim(),
      version: String(env.OPENCLAW_NOTION_VERSION || env.NOTION_VERSION || "2025-09-03").trim(),
      baseUrl: String(env.OPENCLAW_NOTION_API_BASE_URL || env.NOTION_API_BASE_URL || "https://api.notion.com/v1").trim(),
      maxResults: parsePositiveInt(env.OPENCLAW_NOTION_MAX_RESULTS, 5),
      maxResultChars: parsePositiveInt(env.OPENCLAW_NOTION_MAX_RESULT_CHARS, 4000),
    },
  };
};

const assertRuntimeConfig = (config) => {
  const missing = [];
  if (!config.apiKey) missing.push("OPENCLAW_API_KEY");
  if (!config.workspaceDir) missing.push("OPENCLAW_WORKSPACE_DIR");
  if (!config.command) missing.push("OPENCLAW_COMMAND");
  if (config.notion && config.notion.enabled && !config.notion.token) missing.push("OPENCLAW_NOTION_TOKEN");
  if (missing.length > 0) {
    throw new Error(`missing OpenClaw API config: ${missing.join(", ")}`);
  }
};

module.exports = {
  DEFAULT_FIRST_ATTEMPT_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_PROMPT_FILES,
  DEFAULT_RETRY_MIN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS,
  assertRuntimeConfig,
  loadConfig,
  parseBoolean,
  parsePositiveInt,
};
