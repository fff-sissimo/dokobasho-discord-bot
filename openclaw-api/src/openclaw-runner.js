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

const hashDiagnosticText = (value) =>
  createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);

const redactDiagnosticText = (value) => {
  let text = String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/<(?:@!?|@&|#)\d+>/g, "[discord_ref]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd)\s*[:=])\s*\S+/gi, "$1[redacted]")
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, "[auth_redacted]")
    .replace(/(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/gi, "[token_redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[aws_key_redacted]");
  return text.slice(0, 500);
};

const buildStderrDiagnostics = (stderr) => {
  const text = String(stderr || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tailLines = lines.slice(-4);
  const tail = tailLines.join(" | ");
  return {
    stderr_line_count: lines.length,
    stderr_tail_hash: tail ? hashDiagnosticText(tail) : "",
    stderr_tail_safe: redactDiagnosticText(tail),
  };
};

const buildRequestScopedSessionId = ({ sessionId, sessionScope, requestId, message, sessionAttempt }) => {
  const baseSessionId = String(sessionId || "").trim();
  if (!baseSessionId) return "";
  const attemptSegment = sanitizeSessionSegment(sessionAttempt);
  if (sessionScope === "fixed") {
    return attemptSegment ? `${baseSessionId}-${attemptSegment}` : baseSessionId;
  }
  const requestSegment = sanitizeSessionSegment(requestId || extractRequestId(message));
  const scopedSegment = requestSegment || `prompt-${hashPrompt(message)}`;
  const requestScopedSessionId = `${baseSessionId}-req-${scopedSegment}`;
  return attemptSegment ? `${requestScopedSessionId}-${attemptSegment}` : requestScopedSessionId;
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

const emitTraceLog = ({ logger, traceLogs, entry, message }) => {
  if (!traceLogs || !logger || typeof logger.info !== "function") return;
  logger.info(entry, message);
};

const runOpenClawAgent = ({
  config,
  message,
  timeoutMs,
  sessionAttempt,
  logger,
  traceLogs = false,
  requestId,
  channelId,
  attempt,
  attemptMode,
}) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : config.requestTimeoutMs;
    const effectiveTimeoutSeconds = Math.max(
      1,
      Math.min(
        Number(config.timeoutSeconds) || Math.ceil(effectiveTimeoutMs / 1000),
        Math.ceil(effectiveTimeoutMs / 1000)
      )
    );
    const scopedSessionId = buildRequestScopedSessionId({
      sessionId: config.sessionId,
      sessionScope: config.sessionScope,
      requestId,
      message,
      sessionAttempt,
    });
    const args = buildOpenClawArgs({
      agentMode: config.agentMode,
      agentId: config.agentId,
      sessionId: scopedSessionId,
      thinking: config.thinking,
      timeoutSeconds: effectiveTimeoutSeconds,
      message,
    });
    const baseLog = {
      request_id: String(requestId || extractRequestId(message) || "").trim(),
      channel_id: channelId,
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
    };
    const trace = (entry, logMessage = "[openclaw-api] trace") => {
      emitTraceLog({
        logger,
        traceLogs,
        entry: {
          ...baseLog,
          elapsed_ms: Date.now() - startedAt,
          ...entry,
        },
        message: logMessage,
      });
    };
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let sawStdout = false;
    let sawStderr = false;
    let settled = false;
    let timedOut = false;
    let timer;
    let killTimer;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };

    trace({
      stage: "openclaw_spawn_start",
      command: config.command,
      cwd: config.workspaceDir,
      timeout_ms: effectiveTimeoutMs,
      timeout_seconds: effectiveTimeoutSeconds,
      agent_mode: config.agentMode,
      has_agent_id: Boolean(config.agentId),
      has_session_id: Boolean(scopedSessionId),
    });

    let child;
    try {
      child = spawn(config.command, args, {
        cwd: config.workspaceDir,
        env: buildOpenClawChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      error.stage = "openclaw_spawn_error";
      trace({
        stage: "openclaw_spawn_error",
        error_code: error.code || "SPAWN_THROW",
        duration_ms: Date.now() - startedAt,
      });
      fail(error);
      return;
    }
    trace({
      stage: "openclaw_spawned",
      pid: child.pid || 0,
    });
    timer = setTimeout(() => {
      timedOut = true;
      const killSent = child.kill("SIGTERM");
      const stderrDiagnostics = buildStderrDiagnostics(stderr);
      trace({
        stage: "openclaw_timeout_signal_sent",
        pid: child.pid || 0,
        kill_signal: "SIGTERM",
        kill_sent: killSent,
        duration_ms: Date.now() - startedAt,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        ...stderrDiagnostics,
      });
      const killGraceMs = Number.isFinite(Number(config.killGraceMs)) && Number(config.killGraceMs) > 0
        ? Math.floor(Number(config.killGraceMs))
        : 10000;
      killTimer = setTimeout(() => {
        const sigkillSent = child.kill("SIGKILL");
        trace({
          stage: "openclaw_kill_signal_sent",
          pid: child.pid || 0,
          kill_signal: "SIGKILL",
          kill_sent: sigkillSent,
          duration_ms: Date.now() - startedAt,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          ...buildStderrDiagnostics(stderr),
        });
      }, killGraceMs);
      const error = new Error(`OpenClaw command timed out: timeoutMs=${effectiveTimeoutMs}`);
      error.code = "OPENCLAW_TIMEOUT";
      error.stage = "openclaw_timeout";
      error.stdout_bytes = stdoutBytes;
      error.stderr_bytes = stderrBytes;
      Object.assign(error, stderrDiagnostics);
      fail(error);
    }, effectiveTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (!sawStdout) {
        sawStdout = true;
        trace({
          stage: "openclaw_first_stdout_chunk",
          stdout_bytes: stdoutBytes,
          time_to_first_stdout_ms: Date.now() - startedAt,
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (!sawStderr) {
        sawStderr = true;
        trace({
          stage: "openclaw_first_stderr_chunk",
          stderr_bytes: stderrBytes,
          time_to_first_stderr_ms: Date.now() - startedAt,
        });
      }
    });
    child.on("error", (error) => {
      error.stage = "openclaw_spawn_error";
      trace({
        stage: "openclaw_spawn_error",
        pid: child.pid || 0,
        error_code: error.code || "SPAWN_ERROR",
        duration_ms: Date.now() - startedAt,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
      });
      fail(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      const closeCode = code === null
        ? -1
        : Number.isFinite(Number(code)) ? Number(code) : -1;
      trace({
        stage: "openclaw_close",
        pid: child.pid || 0,
        close_code: closeCode,
        close_signal: signal || "",
        duration_ms: Date.now() - startedAt,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        timed_out: timedOut,
        ...buildStderrDiagnostics(stderr),
      });
      if (settled) return;
      if (code !== 0) {
        const error = new Error(`OpenClaw command failed: code=${code}`);
        error.code = "OPENCLAW_EXIT";
        error.stage = "openclaw_close";
        error.stdout_bytes = stdoutBytes;
        error.stderr_bytes = stderrBytes;
        error.stderr = stderr.slice(-4000);
        Object.assign(error, buildStderrDiagnostics(stderr));
        fail(error);
        return;
      }
      succeed(stdout);
    });
  });

module.exports = {
  buildOpenClawArgs,
  buildOpenClawChildEnv,
  buildRequestScopedSessionId,
  buildStderrDiagnostics,
  runOpenClawAgent,
};
