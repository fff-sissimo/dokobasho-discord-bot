"use strict";

const { spawn } = require("node:child_process");

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

const runOpenClawAgent = ({ config, message }) =>
  new Promise((resolve, reject) => {
    const args = buildOpenClawArgs({
      agentMode: config.agentMode,
      agentId: config.agentId,
      sessionId: config.sessionId,
      thinking: config.thinking,
      timeoutSeconds: config.timeoutSeconds,
      message,
    });
    const child = spawn(config.command, args, {
      cwd: config.workspaceDir,
      env: process.env,
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
  runOpenClawAgent,
};
