"use strict";

const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const sanitizeSessionSegment = (value) =>
  String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

const extractRequestId = (message) => {
  const match = String(message || "").match(/"request_id"\s*:\s*"([^"]{1,200})"/);
  return match ? match[1] : "";
};

const hashPrompt = (message) =>
  createHash("sha256").update(String(message || ""), "utf8").digest("hex").slice(0, 16);

const buildRequestScopedSessionId = ({ sessionId, sessionScope, requestId, message }) => {
  const baseSessionId = String(sessionId || "").trim();
  if (!baseSessionId || sessionScope === "fixed") return baseSessionId;
  const requestSegment = sanitizeSessionSegment(requestId || extractRequestId(message));
  const scopedSegment = requestSegment || `prompt-${hashPrompt(message)}`;
  return `${baseSessionId}-req-${scopedSegment}`;
};

const buildOpenClawArgs = ({ agentMode, agentId, sessionId, thinking, timeoutSeconds, message }) => {
  const args = ["agent", "--json"];
  if (agentMode === "local") args.push("--local");
  if (agentId) args.push("--agent", agentId);
  if (sessionId) args.push("--session-id", sessionId);
  if (thinking) args.push("--thinking", thinking);
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  args.push("--message", message);
  return args;
};

const CHILD_ENV_ALLOWLIST = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

const buildOpenClawChildEnv = (sourceEnv = process.env) =>
  Object.fromEntries(
    CHILD_ENV_ALLOWLIST
      .map((name) => [name, sourceEnv[name]])
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
  );

const runOpenClawAgent = ({ config, message }) =>
  new Promise((resolve, reject) => {
    const args = buildOpenClawArgs({
      agentMode: config.agentMode,
      agentId: config.agentId,
      sessionId: buildRequestScopedSessionId({
        sessionId: config.sessionId,
        sessionScope: config.sessionScope,
        message,
      }),
      thinking: config.thinking,
      timeoutSeconds: config.timeoutSeconds,
      message,
    });
    const child = spawn(config.command, args, {
      cwd: config.workspaceDir,
      env: buildOpenClawChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`OpenClaw command timed out: timeoutMs=${config.requestTimeoutMs}`);
      error.code = "OPENCLAW_TIMEOUT";
      reject(error);
    }, config.requestTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`OpenClaw command failed: code=${code}`);
        error.code = "OPENCLAW_EXIT";
        error.stderr = stderr.slice(-4000);
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

module.exports = {
  buildOpenClawArgs,
  buildOpenClawChildEnv,
  buildRequestScopedSessionId,
  runOpenClawAgent,
};
