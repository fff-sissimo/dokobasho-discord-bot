"use strict";

const DEFAULT_PROMPT_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "memory/README.md",
];

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
    promptFiles: parsePromptFiles(env.OPENCLAW_PROMPT_FILES).length > 0
      ? parsePromptFiles(env.OPENCLAW_PROMPT_FILES)
      : DEFAULT_PROMPT_FILES,
  };
};

const assertRuntimeConfig = (config) => {
  const missing = [];
  if (!config.apiKey) missing.push("OPENCLAW_API_KEY");
  if (!config.workspaceDir) missing.push("OPENCLAW_WORKSPACE_DIR");
  if (!config.command) missing.push("OPENCLAW_COMMAND");
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
