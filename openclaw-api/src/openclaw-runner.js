"use strict";

const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const OPENCLAW_SESSION_ID_MAX_CHARS = 64;
const SESSION_HASH_CHARS = 16;
const SESSION_ATTEMPT_MAX_CHARS = 24;

const normalizeSessionSegment = (value) =>
  String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const sanitizeSessionSegment = (value) =>
  normalizeSessionSegment(value).slice(0, 96);

const extractRequestId = (message) => {
  const match = String(message || "").match(/"request_id"\s*:\s*"([^"]{1,200})"/);
  return match ? match[1] : "";
};

const hashPrompt = (message) =>
  createHash("sha256").update(String(message || ""), "utf8").digest("hex").slice(0, SESSION_HASH_CHARS);

const hashSessionValue = (value) =>
  hashPrompt(String(value || "").trim());

const hasUnsafeSessionValue = (value) => {
  const text = String(value || "");
  return /https?:\/\//i.test(text) ||
    /(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|basic)[=/:]/i.test(text) ||
    /(?:^|[\s"'`({\[])(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i.test(text) ||
    /(?:^|[\s"'`({\[])(?:sk-proj-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,})/i.test(text);
};

const shortenSessionSegment = (segment, maxLength) => {
  if (hasUnsafeSessionValue(segment)) {
    const hash = hashSessionValue(segment);
    const prefix = maxLength > SESSION_HASH_CHARS + 1 ? "session-" : "";
    return `${prefix}${hash}`.slice(0, maxLength);
  }
  const safeSegment = normalizeSessionSegment(segment) || "session";
  if (safeSegment.length <= maxLength) return safeSegment;
  const hash = hashSessionValue(segment);
  if (maxLength <= SESSION_HASH_CHARS) return hash.slice(0, maxLength);
  const prefixLength = maxLength - SESSION_HASH_CHARS - 1;
  const prefix = safeSegment.slice(0, prefixLength).replace(/[-_.:]+$/g, "");
  return prefix ? `${prefix}-${hash}` : hash.slice(0, maxLength);
};

const buildSessionAttemptSegment = (sessionAttempt) => {
  const rawAttemptSegment = String(sessionAttempt || "").trim();
  const attemptSegment = normalizeSessionSegment(rawAttemptSegment);
  if (!attemptSegment) return rawAttemptSegment ? `attempt-${hashSessionValue(rawAttemptSegment)}` : "";
  if (attemptSegment.length <= SESSION_ATTEMPT_MAX_CHARS) return attemptSegment;
  return `attempt-${hashSessionValue(rawAttemptSegment)}`;
};

const buildBoundedSessionId = ({ baseSessionId, trailingSegments = [] }) => {
  const segments = trailingSegments.map(sanitizeSessionSegment).filter(Boolean);
  const suffix = segments.length ? `-${segments.join("-")}` : "";
  const maxBaseLength = Math.max(1, OPENCLAW_SESSION_ID_MAX_CHARS - suffix.length);
  const safeBaseSessionId = shortenSessionSegment(baseSessionId, maxBaseLength);
  return `${safeBaseSessionId}${suffix}`;
};

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
  const attemptSegment = buildSessionAttemptSegment(sessionAttempt);
  if (sessionScope === "fixed") {
    return buildBoundedSessionId({
      baseSessionId,
      trailingSegments: attemptSegment ? [attemptSegment] : [],
    });
  }
  const rawRequestSegment = String(requestId || extractRequestId(message) || "").trim();
  const scopedSegment = rawRequestSegment ? `req-${hashSessionValue(rawRequestSegment)}` : `prompt-${hashPrompt(message)}`;
  return buildBoundedSessionId({
    baseSessionId,
    trailingSegments: attemptSegment ? [scopedSegment, attemptSegment] : [scopedSegment],
  });
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

const isSafeSessionFileSegment = (sessionId) => {
  const value = String(sessionId || "").trim();
  return Boolean(value)
    && value === path.basename(value)
    && !value.includes("..")
    && /^[A-Za-z0-9_.:-]+$/.test(value);
};

const buildOpenClawSessionStatePaths = ({ homeDir, sessionId }) => {
  const safeHomeDir = String(homeDir || "").trim();
  if (!safeHomeDir || !isSafeSessionFileSegment(sessionId)) return [];
  const sessionsDir = path.join(safeHomeDir, ".openclaw", "agents", "main", "sessions");
  return [
    path.join(sessionsDir, `${sessionId}.jsonl`),
    path.join(sessionsDir, `${sessionId}.trajectory.jsonl`),
  ];
};

const cleanupOpenClawSessionState = async ({ homeDir, sessionId }) => {
  const statePaths = buildOpenClawSessionStatePaths({ homeDir, sessionId });
  let removedPaths = 0;
  for (const statePath of statePaths) {
    try {
      await fs.stat(statePath);
      await fs.rm(statePath, { force: true });
      removedPaths += 1;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return {
    attempted_paths: statePaths.length,
    removed_paths: removedPaths,
  };
};

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
    const childEnv = buildOpenClawChildEnv();
    const childHomeDir = childEnv.HOME || "";
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
    let timeoutError;
    let timer;
    let killTimer;
    let cleanupChain = Promise.resolve();

    const cleanupSessionState = (cleanupStage) => {
      if (config.cleanupSessionState === false || !childHomeDir || !scopedSessionId) return Promise.resolve();
      cleanupChain = cleanupChain
        .then(async () => {
          trace({
            stage: "openclaw_session_cleanup_start",
            cleanup_stage: cleanupStage,
            has_session_id: Boolean(scopedSessionId),
          });
          const cleanupResult = await cleanupOpenClawSessionState({
            homeDir: childHomeDir,
            sessionId: scopedSessionId,
          });
          trace({
            stage: "openclaw_session_cleanup_end",
            cleanup_stage: cleanupStage,
            ...cleanupResult,
          });
        })
        .catch((error) => {
          const cleanupError = new Error("OpenClaw session state cleanup failed");
          cleanupError.code = "OPENCLAW_SESSION_CLEANUP_FAILED";
          cleanupError.stage = "openclaw_session_cleanup_error";
          cleanupError.cause = error;
          if (logger && typeof logger.warn === "function") {
            logger.warn({
              ...baseLog,
              stage: "openclaw_session_cleanup_error",
              cleanup_stage: cleanupStage,
              elapsed_ms: Date.now() - startedAt,
              error_code: error && error.code ? error.code : "OPENCLAW_SESSION_CLEANUP_ERROR",
            }, "[openclaw-api] OpenClaw session state cleanup failed");
          }
          trace({
            stage: "openclaw_session_cleanup_error",
            cleanup_stage: cleanupStage,
            error_code: error && error.code ? error.code : "OPENCLAW_SESSION_CLEANUP_ERROR",
          });
          throw cleanupError;
        });
      return cleanupChain;
    };

    const fail = (error, cleanupStage = "settle_error") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanupPromise = cleanupStage ? cleanupSessionState(cleanupStage) : Promise.resolve();
      cleanupPromise.then(
        () => reject(error),
        (cleanupError) => reject(cleanupError)
      );
    };
    const succeed = (value, cleanupStage = "settle_success") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const cleanupPromise = cleanupStage ? cleanupSessionState(cleanupStage) : Promise.resolve();
      cleanupPromise.then(
        () => resolve(value),
        (cleanupError) => reject(cleanupError)
      );
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
        env: childEnv,
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
      if (settled) return;
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
      timeoutError = error;
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
      clearTimeout(timer);
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
      cleanupSessionState("close").then(
        () => {
          if (settled) return;
          if (timeoutError) {
            fail(timeoutError, null);
            return;
          }
          if (code !== 0) {
            const error = new Error(`OpenClaw command failed: code=${code}`);
            error.code = "OPENCLAW_EXIT";
            error.stage = "openclaw_close";
            error.stdout_bytes = stdoutBytes;
            error.stderr_bytes = stderrBytes;
            error.stderr = stderr.slice(-4000);
            Object.assign(error, buildStderrDiagnostics(stderr));
            fail(error, null);
            return;
          }
          succeed(stdout, null);
        },
        (cleanupError) => {
          if (settled) return;
          fail(cleanupError, null);
        }
      );
    });
  });

module.exports = {
  buildOpenClawArgs,
  buildOpenClawChildEnv,
  buildOpenClawSessionStatePaths,
  buildRequestScopedSessionId,
  buildStderrDiagnostics,
  cleanupOpenClawSessionState,
  runOpenClawAgent,
};
