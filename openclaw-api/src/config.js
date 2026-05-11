"use strict";

const DEFAULT_PROMPT_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "skills/n8n-workflow-dispatcher/SKILL.md",
  "HEARTBEAT.md",
  "memory/README.md",
];

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const parsePromptFiles = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseList = (value) =>
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
    timeoutSeconds: parsePositiveInt(env.OPENCLAW_AGENT_TIMEOUT_SECONDS, 60),
    requestTimeoutMs: parsePositiveInt(env.OPENCLAW_REQUEST_TIMEOUT_MS, 70000),
    maxBodyBytes: parsePositiveInt(env.OPENCLAW_API_MAX_BODY_BYTES, 65536),
    requestAuditPath: String(env.OPENCLAW_REQUEST_AUDIT_PATH || "data/request-audit.jsonl").trim(),
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
    n8nDispatch: {
      enabled: parseBoolean(env.OPENCLAW_N8N_DISPATCH_ENABLED, false),
      url: String(env.OPENCLAW_N8N_DISPATCH_URL || "").trim(),
      secret: String(env.OPENCLAW_N8N_DISPATCH_SECRET || "").trim(),
      allowedWorkflows: parseList(env.OPENCLAW_N8N_ALLOWED_WORKFLOWS || "notion.safe_ops"),
      timeoutMs: parsePositiveInt(env.OPENCLAW_N8N_DISPATCH_TIMEOUT_MS, 20000),
    },
  };
};

const assertRuntimeConfig = (config) => {
  const missing = [];
  if (!config.apiKey) missing.push("OPENCLAW_API_KEY");
  if (!config.workspaceDir) missing.push("OPENCLAW_WORKSPACE_DIR");
  if (!config.command) missing.push("OPENCLAW_COMMAND");
  if (config.notion && config.notion.enabled && !config.notion.token) missing.push("OPENCLAW_NOTION_TOKEN");
  if (config.n8nDispatch && config.n8nDispatch.enabled) {
    if (!config.n8nDispatch.url) missing.push("OPENCLAW_N8N_DISPATCH_URL");
    if (!config.n8nDispatch.secret) missing.push("OPENCLAW_N8N_DISPATCH_SECRET");
  }
  if (missing.length > 0) {
    throw new Error(`missing OpenClaw API config: ${missing.join(", ")}`);
  }
};

module.exports = {
  DEFAULT_PROMPT_FILES,
  assertRuntimeConfig,
  loadConfig,
  parsePositiveInt,
};
