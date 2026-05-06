"use strict";

const http = require("node:http");

const { assertRuntimeConfig, loadConfig } = require("./config");
const {
  buildAgentPrompt,
  buildCompactAgentPrompt,
  buildObserveResponse,
  buildRetryAgentPrompt,
  loadWorkspaceContext,
  normalizeSafeDiagnostics,
  parseAgentResponse,
} = require("./contracts");
const { runOpenClawAgent } = require("./openclaw-runner");

const sendJson = (res, statusCode, body) => {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
};

const readJsonBody = (req, maxBodyBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error("invalid json");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });

const isAuthorized = (req, apiKey) => {
  const header = String(req.headers.authorization || "").trim();
  return header === `Bearer ${apiKey}`;
};

const LOGGABLE_REASON_CODES = new Set([
  "OPENCLAW_EXIT",
  "OPENCLAW_TIMEOUT",
  "context_overflow",
  "invalid_openclaw_action",
  "invalid_openclaw_response",
  "openclaw_error_text",
  "openclaw_execution_failed",
  "secret_like_output",
  "unparseable_openclaw_output",
]);

const safeLogIdentifier = (value) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd)\s*[:=]/i.test(text)) return "[redacted]";
  if (/(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i.test(text)) return "[redacted]";
  if (/(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/i.test(text)) return "[redacted]";
  if (/AKIA[0-9A-Z]{16}/.test(text)) return "[redacted]";
  if (LOGGABLE_REASON_CODES.has(text)) return text;
  return "[freeform]";
};

const safeLogText = (value, { maxLength = 120 } = {}) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd)\s*[:=]/i.test(text)) return "[redacted]";
  if (/(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i.test(text)) return "[redacted]";
  return text.slice(0, maxLength);
};

const emitTraceLog = ({ config, logger, entry, message = "[openclaw-api] trace" }) => {
  if (!config.traceLogs || !logger || typeof logger.info !== "function") return;
  logger.info(entry, message);
};

const FAILURE_OBSERVE_REASONS = new Set([
  "context_overflow",
  "invalid_openclaw_action",
  "invalid_openclaw_response",
  "openclaw_error_text",
  "secret_like_output",
  "unparseable_openclaw_output",
]);

const isFailureObserveResponse = (response) =>
  response &&
  response.action === "observe" &&
  FAILURE_OBSERVE_REASONS.has(String(response.reason || "").trim());

const attachFailureDiagnostics = (response, diagnostics) => {
  const normalizedDiagnostics = normalizeSafeDiagnostics(diagnostics);
  if (Object.keys(normalizedDiagnostics).length === 0) return response;
  return {
    ...response,
    diagnostics: normalizedDiagnostics,
  };
};

const RETRY_MESSAGE_CONTENT_MAX_CHARS = 500;
const NORMAL_MESSAGE_CONTENT_MAX_CHARS = 1000;
const NORMAL_RECENT_MESSAGE_CONTENT_MAX_CHARS = 200;
const RETRY_LIST_MAX_ITEMS = 5;
const RETRY_IDENTIFIER_MAX_CHARS = 80;
const OPS_OPTIONAL_CONTEXT_MAX_CHARS = 500;
const FOLLOWUP_OPTIONAL_CONTEXT_MAX_CHARS = 500;

const normalizeRetryIdentifierList = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS))
    .filter(Boolean)
    .slice(0, RETRY_LIST_MAX_ITEMS);

const normalizeRetryAttachments = (value) =>
  (Array.isArray(value) ? value : [])
    .slice(0, RETRY_LIST_MAX_ITEMS)
    .map((attachment) => {
      const source = attachment && typeof attachment === "object" && !Array.isArray(attachment) ? attachment : {};
      return {
        id: String(source.id || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS),
        content_type: String(source.content_type || source.contentType || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS),
        size: Number.isFinite(source.size) ? source.size : null,
      };
    });

const normalizeRetryLinks = (value) =>
  (Array.isArray(value) ? value : [])
    .slice(0, RETRY_LIST_MAX_ITEMS)
    .map((link) => ({
      present: Boolean(String(link || "").trim()),
    }));

const redactPromptText = (value) =>
  String(value || "").replace(/https?:\/\/\S+/gi, "[external_url]");

const normalizePromptRecentMessages = (value) =>
  (Array.isArray(value) ? value : [])
    .slice(0, RETRY_LIST_MAX_ITEMS)
    .map((message) => {
      const source = message && typeof message === "object" && !Array.isArray(message) ? message : {};
      return {
        message_id: String(source.message_id || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS),
        author_id: String(source.author_id || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS),
        content: redactPromptText(source.content).slice(0, NORMAL_RECENT_MESSAGE_CONTENT_MAX_CHARS),
        created_at: String(source.created_at || "").trim().slice(0, RETRY_IDENTIFIER_MAX_CHARS),
      };
    })
    .filter((message) => message.message_id && message.author_id && message.content);

const isSelfContainedDirectRequest = ({ message, context }) => {
  const content = String(message.content || "");
  if (!(message.mentions_bot || message.is_reply_to_bot)) return false;
  if (message.is_reply_to_bot) return false;
  if (content.length > 220) return false;
  if (context.has_promised_followup) return false;
  if (Array.isArray(context.matched_followup_ids) && context.matched_followup_ids.length > 0) return false;
  if (/(?:さっき|先ほど|先程|先日|以前|直前|今の件|上記|前(?:の|回)?|上(?:の)?|これ|それ|あれ|この|その|続き|文脈|話題|どう思う)/.test(content)) {
    return false;
  }
  const hasRecentContext = Array.isArray(context.recent_messages) && context.recent_messages.length > 0;
  if (/live smoke/i.test(content) || /(?:^|[^A-Za-z])ping(?:$|[^A-Za-z])/i.test(content)) return true;
  if (/(?:短い挨拶|挨拶して|挨拶してください)/.test(content)) return true;
  if (/(?:今の調子|疎通|テスト).{0,24}(?:一言|ひとこと)/.test(content)) return true;
  return !hasRecentContext && /(?:一言で返して|一言で返信|一言で返してください|ひとこと(?:で)?返して)/.test(content);
};

const CONTEXT_DEPENDENT_PATTERN = /(?:さっき|先ほど|先程|先日|以前|直前|今の件|上記|前(?:の|回)?|上(?:の)?|これ|それ|あれ|この|その|続き|文脈|話題|どう思う)/;
const DIRECT_COMPACT_PATTERN = /live smoke/i;
const isDirectCompactText = (content, { hasRecentContext = false } = {}) => {
  if (DIRECT_COMPACT_PATTERN.test(content)) return true;
  if (/(?:^|[^A-Za-z])ping(?:$|[^A-Za-z])/i.test(content)) return true;
  if (/(?:短い挨拶|挨拶して|挨拶してください)/.test(content)) return true;
  if (/(?:今の調子|疎通|テスト).{0,24}(?:一言|ひとこと)/.test(content)) return true;
  return !hasRecentContext && /(?:一言で返して|一言で返信|一言で返してください|ひとこと(?:で)?返して)/.test(content);
};

const hasCompactFirstInputRisk = (message) => {
  const content = String(message.content || "");
  if (/@everyone|@here/i.test(content)) return true;
  if (/<@&\d+>/i.test(content)) return true;
  if (/https?:\/\/\S+/i.test(content)) return true;
  if (message.mentions_everyone) return true;
  if (Array.isArray(message.role_mentions) && message.role_mentions.length > 0) return true;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return true;
  if (Array.isArray(message.links) && message.links.length > 0) return true;
  return false;
};

const isCompactFirstRequest = (payload) => {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const message = source.message && typeof source.message === "object" && !Array.isArray(source.message)
    ? source.message
    : {};
  const context = source.context && typeof source.context === "object" && !Array.isArray(source.context)
    ? source.context
    : {};
  const content = String(message.content || "");
  if (!message.mentions_bot) return false;
  if (message.is_reply_to_bot) return false;
  if (content.length > 220) return false;
  if (CONTEXT_DEPENDENT_PATTERN.test(content)) return false;
  if (context.has_promised_followup) return false;
  if (Array.isArray(context.matched_followup_ids) && context.matched_followup_ids.length > 0) return false;
  if (hasCompactFirstInputRisk(message)) return false;
  return isDirectCompactText(content, {
    hasRecentContext: Array.isArray(context.recent_messages) && context.recent_messages.length > 0,
  });
};

const buildPromptPayload = (payload, { mode = "normal" } = {}) => {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const channel = source.channel && typeof source.channel === "object" && !Array.isArray(source.channel)
    ? source.channel
    : {};
  const message = source.message && typeof source.message === "object" && !Array.isArray(source.message)
    ? source.message
    : {};
  const context = source.context && typeof source.context === "object" && !Array.isArray(source.context)
    ? source.context
    : {};
  const contentMaxChars = mode === "retry" ? RETRY_MESSAGE_CONTENT_MAX_CHARS : NORMAL_MESSAGE_CONTENT_MAX_CHARS;
  const projectedMessage = {
    id: String(message.id || "").trim(),
    author_id: String(message.author_id || "").trim(),
    content: redactPromptText(message.content).slice(0, contentMaxChars),
    created_at: String(message.created_at || "").trim(),
    is_reply_to_bot: Boolean(message.is_reply_to_bot),
    mentions_bot: Boolean(message.mentions_bot),
    mentions_everyone: Boolean(message.mentions_everyone),
    role_mentions: normalizeRetryIdentifierList(message.role_mentions),
    attachments: normalizeRetryAttachments(message.attachments),
    links: normalizeRetryLinks(message.links),
  };
  const projectedContext = {
    recent_messages: normalizePromptRecentMessages(context.recent_messages),
    active_thread_age_minutes: context.active_thread_age_minutes ?? null,
    has_promised_followup: Boolean(context.has_promised_followup),
    matched_followup_ids: normalizeRetryIdentifierList(context.matched_followup_ids),
  };
  if (mode === "retry" || isSelfContainedDirectRequest({ message: projectedMessage, context: projectedContext })) {
    projectedContext.recent_messages = [];
  }
  return {
    request_id: String(source.request_id || "").trim(),
    schema_version: 1,
    source: "discord",
    event_type: String(source.event_type || "").trim(),
    received_at: String(source.received_at || "").trim(),
    guild_id: String(source.guild_id || "").trim(),
    channel: {
      id: String(channel.id || "").trim(),
      type: String(channel.type || "").trim(),
      registered: Boolean(channel.registered),
      thread_id: String(channel.thread_id || "").trim(),
      parent_channel_id: String(channel.parent_channel_id || "").trim(),
      category_id: String(channel.category_id || "").trim(),
    },
    message: projectedMessage,
    context: projectedContext,
  };
};

const buildMinimalRetryPayload = (payload) => buildPromptPayload(payload, { mode: "retry" });

const hasFollowupSignals = (payload) => {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const context = source.context && typeof source.context === "object" && !Array.isArray(source.context)
    ? source.context
    : {};
  if (context.has_promised_followup) return true;
  if (Array.isArray(context.matched_followup_ids) && context.matched_followup_ids.length > 0) return true;
  const eventType = String(source.event_type || "").trim();
  return /followup/i.test(eventType);
};

const buildOptionalPromptFiles = (payload) => {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const channel = source.channel && typeof source.channel === "object" && !Array.isArray(source.channel)
    ? source.channel
    : {};
  const files = [];
  if (hasFollowupSignals(source)) {
    files.push({
      path: "OPEN_ITEMS.md",
      label: "OPEN_ITEMS.md followup open items excerpt",
      optional: true,
      headings: [
        "publish 予約と followup の扱いが矛盾している",
        "followup の `checked` が終端か再確認待ちか曖昧",
        "followup の時刻形式とタイムゾーンが未定義",
        "sandbox followup の扱いが未定義",
      ],
      maxChars: FOLLOWUP_OPTIONAL_CONTEXT_MAX_CHARS,
    });
  }
  if (String(channel.type || "").trim() === "ops") {
    files.push({
      path: "TOOLS.md",
      label: "TOOLS.md ops publish boundaries excerpt",
      optional: true,
      headings: ["ops", "Publish approval flow", "Publish boundaries"],
      maxChars: OPS_OPTIONAL_CONTEXT_MAX_CHARS,
    });
  }
  return files;
};

const executeOpenClawPrompt = async ({
  config,
  payload,
  workspaceContext,
  runAgentCommand,
  projectPayload = true,
  timeoutMs,
  promptBuilder = buildAgentPrompt,
  sessionAttempt,
  logger,
  trace,
  attempt,
  attemptMode,
}) => {
  const attemptStartedAt = Date.now();
  const promptPayload = projectPayload ? buildPromptPayload(payload) : payload;
  const prompt = promptBuilder({ payload: promptPayload, workspaceContext });
  const promptBuilderName = promptBuilder === buildCompactAgentPrompt
    ? "compact"
    : promptBuilder === buildRetryAgentPrompt
      ? "retry"
      : "full";
  if (trace) {
    trace({
      stage: "prompt_built",
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
      prompt_builder: promptBuilderName,
      project_payload: projectPayload,
      prompt_chars: prompt.length,
      workspace_context_chars: String(workspaceContext || "").length,
      timeout_ms: timeoutMs,
    });
    trace({
      stage: "openclaw_attempt_start",
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
      timeout_ms: timeoutMs,
      prompt_chars: prompt.length,
    });
  }
  let stdout;
  try {
    stdout = await runAgentCommand({
      config,
      message: prompt,
      timeoutMs,
      sessionAttempt,
      logger,
      traceLogs: Boolean(config.traceLogs),
      requestId: payload.request_id,
      channelId: payload.channel && payload.channel.id,
      attempt,
      attemptMode,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      error.prompt = prompt;
      error.attempt_elapsed_ms = Date.now() - attemptStartedAt;
      error.stage = error.stage || "openclaw_attempt_failed";
    }
    if (trace) {
      trace({
        stage: "openclaw_attempt_fail",
        attempt,
        session_attempt: sessionAttempt || "first",
        attempt_mode: attemptMode,
        timeout_ms: timeoutMs,
        prompt_chars: prompt.length,
        duration_ms: Date.now() - attemptStartedAt,
        error_code: error && error.code ? error.code : "openclaw_execution_failed",
        stdout_bytes: error && Number.isFinite(Number(error.stdout_bytes)) ? Number(error.stdout_bytes) : 0,
        stderr_bytes: error && Number.isFinite(Number(error.stderr_bytes)) ? Number(error.stderr_bytes) : 0,
      });
    }
    throw error;
  }
  if (trace) {
    trace({
      stage: "openclaw_attempt_end",
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
      timeout_ms: timeoutMs,
      prompt_chars: prompt.length,
      duration_ms: Date.now() - attemptStartedAt,
      stdout_bytes: Buffer.byteLength(String(stdout || ""), "utf8"),
    });
    trace({
      stage: "openclaw_parse_start",
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
      stdout_bytes: Buffer.byteLength(String(stdout || ""), "utf8"),
    });
  }
  const response = parseAgentResponse(stdout);
  if (trace) {
    trace({
      stage: "openclaw_parse_end",
      attempt,
      session_attempt: sessionAttempt || "first",
      attempt_mode: attemptMode,
      stdout_bytes: Buffer.byteLength(String(stdout || ""), "utf8"),
      response_action: response.action,
      reason: safeLogIdentifier(response.reason),
    });
  }
  return {
    prompt,
    response,
    attempt_elapsed_ms: Date.now() - attemptStartedAt,
    stdout_bytes: Buffer.byteLength(String(stdout || ""), "utf8"),
  };
};

const remainingRequestTimeoutMs = ({ config, requestStartedAt }) =>
  Math.max(0, Number(config.requestTimeoutMs || 0) - (Date.now() - requestStartedAt));

const firstAttemptTimeoutMs = ({ config, requestStartedAt }) =>
  Math.min(
    remainingRequestTimeoutMs({ config, requestStartedAt }),
    Number(config.firstAttemptTimeoutMs || config.requestTimeoutMs || 0)
  );

const buildTimeoutError = () => {
  const error = new Error("OpenClaw request deadline exhausted");
  error.code = "OPENCLAW_TIMEOUT";
  return error;
};

const RETRYABLE_INITIAL_ERROR_CODES = new Set(["OPENCLAW_TIMEOUT", "OPENCLAW_EXIT"]);
const isRetryableInitialError = (error) =>
  error && RETRYABLE_INITIAL_ERROR_CODES.has(String(error.code || ""));

const createServer = ({
  config = loadConfig(),
  logger = console,
  runAgentCommand = runOpenClawAgent,
  loadContext = loadWorkspaceContext,
} = {}) => {
  assertRuntimeConfig(config);
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "openclaw-api",
        workspace_dir: config.workspaceDir,
        agent_mode: config.agentMode,
      });
      return;
    }

    if (req.method !== "POST" || req.url !== "/discord/respond") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (!isAuthorized(req, config.apiKey)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }

    const requestId = String(payload.request_id || "").trim();
    const requestStartedAt = Date.now();
    let effectiveFirstAttemptTimeoutMs = 0;
    let lastStage = "request_received";
    const trace = (entry) => {
      if (entry && entry.stage) lastStage = entry.stage;
      emitTraceLog({
        config,
        logger,
        entry: {
          request_id: requestId,
          channel_id: payload.channel && payload.channel.id,
          elapsed_ms: Date.now() - requestStartedAt,
          ...entry,
        },
      });
    };
    try {
      const compactFirst = isCompactFirstRequest(payload);
      const attemptMode = compactFirst ? "compact_first" : "full_first";
      trace({
        stage: "request_received",
        event_type: safeLogText(payload.event_type, { maxLength: 32 }),
        message_id: payload.message && payload.message.id,
        attempt_mode: attemptMode,
        compact_first: compactFirst,
      });
      let workspaceContext = "";
      if (!compactFirst) {
        const contextStartedAt = Date.now();
        trace({
          stage: "workspace_context_load_start",
          attempt_mode: attemptMode,
          prompt_file_count: Array.isArray(config.promptFiles) ? config.promptFiles.length : 0,
        });
        try {
          const optionalPromptFiles = buildOptionalPromptFiles(payload);
          const promptFiles = [
            ...config.promptFiles,
            ...optionalPromptFiles,
          ];
          workspaceContext = await loadContext({
            workspaceDir: config.workspaceDir,
            promptFiles,
            maxChars: config.maxWorkspaceContextChars,
            required: true,
          });
          trace({
            stage: "workspace_context_load_end",
            attempt_mode: attemptMode,
            workspace_context_chars: workspaceContext.length,
            prompt_file_count: promptFiles.length,
            optional_prompt_file_count: optionalPromptFiles.length,
            duration_ms: Date.now() - contextStartedAt,
          });
        } catch (error) {
          trace({
            stage: "workspace_context_load_fail",
            attempt_mode: attemptMode,
            prompt_file_count: Array.isArray(config.promptFiles) ? config.promptFiles.length : 0,
            optional_prompt_file_count: buildOptionalPromptFiles(payload).length,
            duration_ms: Date.now() - contextStartedAt,
            error_code: error && error.code ? error.code : "workspace_context_error",
          });
          throw error;
        }
      }
      const firstTimeoutMs = firstAttemptTimeoutMs({ config, requestStartedAt });
      effectiveFirstAttemptTimeoutMs = firstTimeoutMs;
      if (firstTimeoutMs <= 0) throw buildTimeoutError();
      let result;
      let initialPromptChars = 0;
      let retryCount = 0;
      let retryPromptChars = 0;
      let retryErrorCode = "";
      let initialError = null;
      let firstAttemptElapsedMs = 0;
      let retryElapsedMs = 0;
      let retrySkipReason = "";
      let retryLastStage = "";
      let retryStdoutBytes = 0;
      let retryStderrBytes = 0;
      let retryStderrLineCount = 0;
      let retryStderrTailHash = "";
      try {
        if (compactFirst) {
          const compactPayload = buildMinimalRetryPayload(payload);
          result = await executeOpenClawPrompt({
            config,
            payload: compactPayload,
            workspaceContext: "",
            runAgentCommand,
            projectPayload: false,
            timeoutMs: firstTimeoutMs,
            promptBuilder: buildCompactAgentPrompt,
            logger,
            trace,
            attempt: "first",
            attemptMode,
          });
        } else {
          result = await executeOpenClawPrompt({
            config,
            payload,
            workspaceContext,
            runAgentCommand,
            timeoutMs: firstTimeoutMs,
            logger,
            trace,
            attempt: "first",
            attemptMode,
          });
        }
        initialPromptChars = result.prompt.length;
        firstAttemptElapsedMs = result.attempt_elapsed_ms || 0;
      } catch (error) {
        initialError = error;
        initialPromptChars = error && error.prompt ? String(error.prompt).length : 0;
        firstAttemptElapsedMs = error && Number.isFinite(Number(error.attempt_elapsed_ms))
          ? Number(error.attempt_elapsed_ms)
          : 0;
        if (!isRetryableInitialError(error)) {
          throw error;
        }
      }
      if (
        !initialError &&
        result &&
        result.response.action === "observe" &&
        result.response.reason === "context_overflow"
      ) {
        const retryTimeoutMs = remainingRequestTimeoutMs({ config, requestStartedAt });
        const retryAllowed = retryTimeoutMs >= config.retryMinTimeoutMs;
        retrySkipReason = retryAllowed ? "" : "insufficient_time";
        trace({
          stage: "retry_decision",
          attempt_mode: attemptMode,
          retry_reason: "context_overflow",
          retry_allowed: retryAllowed,
          retry_timeout_ms: retryTimeoutMs,
          retry_min_timeout_ms: config.retryMinTimeoutMs,
          retry_skip_reason: retrySkipReason,
        });
        if (retryAllowed) {
          const retryPayload = buildMinimalRetryPayload(payload);
          retryCount = 1;
          try {
            result = await executeOpenClawPrompt({
              config,
              payload: retryPayload,
              workspaceContext: "",
              runAgentCommand,
              projectPayload: false,
              timeoutMs: retryTimeoutMs,
              promptBuilder: buildRetryAgentPrompt,
              sessionAttempt: "retry-1",
              logger,
              trace,
              attempt: "retry",
              attemptMode,
            });
            retryPromptChars = result.prompt.length;
            retryElapsedMs = result.attempt_elapsed_ms || 0;
          } catch (error) {
            retryErrorCode = error && error.code ? error.code : "openclaw_execution_failed";
            retryPromptChars = error && error.prompt ? String(error.prompt).length : 0;
            retryElapsedMs = error && Number.isFinite(Number(error.attempt_elapsed_ms))
              ? Number(error.attempt_elapsed_ms)
              : 0;
            retryLastStage = error && error.stage ? String(error.stage) : "openclaw_attempt_failed";
            retryStdoutBytes = error && Number.isFinite(Number(error.stdout_bytes))
              ? Number(error.stdout_bytes)
              : 0;
            retryStderrBytes = error && Number.isFinite(Number(error.stderr_bytes))
              ? Number(error.stderr_bytes)
              : 0;
            retryStderrLineCount = error && Number.isFinite(Number(error.stderr_line_count))
              ? Number(error.stderr_line_count)
              : 0;
            retryStderrTailHash = error && error.stderr_tail_hash ? String(error.stderr_tail_hash) : "";
          }
        }
      }
      if (initialError) {
        const retryTimeoutMs = remainingRequestTimeoutMs({ config, requestStartedAt });
        const retryAllowed = retryTimeoutMs >= config.retryMinTimeoutMs;
        retrySkipReason = retryAllowed ? "" : "insufficient_time";
        trace({
          stage: "retry_decision",
          attempt_mode: attemptMode,
          retry_reason: "initial_error",
          retry_allowed: retryAllowed,
          retry_timeout_ms: retryTimeoutMs,
          retry_min_timeout_ms: config.retryMinTimeoutMs,
          retry_skip_reason: retrySkipReason,
          initial_error_code: initialError && initialError.code ? initialError.code : "openclaw_execution_failed",
        });
        if (retryAllowed) {
          const retryPayload = buildMinimalRetryPayload(payload);
          retryCount = 1;
          try {
            result = await executeOpenClawPrompt({
              config,
              payload: retryPayload,
              workspaceContext: "",
              runAgentCommand,
              projectPayload: false,
              timeoutMs: retryTimeoutMs,
              promptBuilder: buildRetryAgentPrompt,
              sessionAttempt: "retry-1",
              logger,
              trace,
              attempt: "retry",
              attemptMode,
            });
            retryPromptChars = result.prompt.length;
            retryElapsedMs = result.attempt_elapsed_ms || 0;
          } catch (error) {
            retryErrorCode = error && error.code ? error.code : "openclaw_execution_failed";
            retryPromptChars = error && error.prompt ? String(error.prompt).length : 0;
            retryElapsedMs = error && Number.isFinite(Number(error.attempt_elapsed_ms))
              ? Number(error.attempt_elapsed_ms)
              : 0;
            retryLastStage = error && error.stage ? String(error.stage) : "openclaw_attempt_failed";
            retryStdoutBytes = error && Number.isFinite(Number(error.stdout_bytes))
              ? Number(error.stdout_bytes)
              : 0;
            retryStderrBytes = error && Number.isFinite(Number(error.stderr_bytes))
              ? Number(error.stderr_bytes)
              : 0;
            retryStderrLineCount = error && Number.isFinite(Number(error.stderr_line_count))
              ? Number(error.stderr_line_count)
              : 0;
            retryStderrTailHash = error && error.stderr_tail_hash ? String(error.stderr_tail_hash) : "";
            if (initialError && typeof initialError === "object") {
              initialError.retry_count = retryCount;
              initialError.retry_prompt_chars = retryPromptChars;
              initialError.retry_error_code = retryErrorCode;
              initialError.retry_elapsed_ms = retryElapsedMs;
              initialError.retry_last_stage = retryLastStage;
              initialError.retry_stdout_bytes = retryStdoutBytes;
              initialError.retry_stderr_bytes = retryStderrBytes;
              initialError.retry_stderr_line_count = retryStderrLineCount;
              initialError.retry_stderr_tail_hash = retryStderrTailHash;
            }
            throw initialError;
          }
        } else {
          if (initialError && typeof initialError === "object") {
            initialError.retry_skip_reason = retrySkipReason;
          }
          throw initialError;
        }
      }
      const response = result.response;
      const metrics = {
        request_id: requestId,
        reason_code: response.reason,
        attempt_mode: attemptMode,
        elapsed_ms: Date.now() - requestStartedAt,
        first_attempt_timeout_ms: firstTimeoutMs,
        prompt_chars: result.prompt.length,
        initial_prompt_chars: initialPromptChars,
        first_attempt_elapsed_ms: firstAttemptElapsedMs,
        retry_count: retryCount,
        retry_prompt_chars: retryPromptChars,
        retry_elapsed_ms: retryElapsedMs,
        workspace_context_chars: workspaceContext.length,
        stdout_bytes: result.stdout_bytes || 0,
        last_stage: "request_completed",
        retry_skip_reason: retrySkipReason,
      };
      if (retryCount > 0) {
        metrics.retry_stdout_bytes = retryStdoutBytes;
        metrics.retry_stderr_bytes = retryStderrBytes;
        metrics.retry_stderr_line_count = retryStderrLineCount;
        if (retryLastStage) metrics.retry_last_stage = retryLastStage;
        if (retryStderrTailHash) metrics.retry_stderr_tail_hash = retryStderrTailHash;
      }
      if (retryErrorCode) {
        metrics.error_code = retryErrorCode;
      }
      logger.info({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        action: response.action,
        reason: safeLogIdentifier(response.reason),
        confidence: safeLogText(response.confidence, { maxLength: 24 }),
        body_len: typeof response.body === "string" ? response.body.length : 0,
        elapsed_ms: metrics.elapsed_ms,
        prompt_chars: metrics.prompt_chars,
        initial_prompt_chars: metrics.initial_prompt_chars,
        first_attempt_elapsed_ms: metrics.first_attempt_elapsed_ms,
        retry_count: metrics.retry_count,
        retry_prompt_chars: metrics.retry_prompt_chars,
        retry_elapsed_ms: metrics.retry_elapsed_ms,
        retry_stdout_bytes: metrics.retry_stdout_bytes,
        retry_stderr_bytes: metrics.retry_stderr_bytes,
        retry_stderr_line_count: metrics.retry_stderr_line_count,
        retry_stderr_tail_hash: metrics.retry_stderr_tail_hash,
        attempt_mode: metrics.attempt_mode,
        first_attempt_timeout_ms: metrics.first_attempt_timeout_ms,
        workspace_context_chars: metrics.workspace_context_chars,
        stdout_bytes: metrics.stdout_bytes,
        stage: metrics.last_stage,
        retry_last_stage: metrics.retry_last_stage,
        retry_skip_reason: metrics.retry_skip_reason,
      }, "[openclaw-api] request completed");
      sendJson(res, 200, isFailureObserveResponse(response)
        ? attachFailureDiagnostics(response, metrics)
        : response);
    } catch (error) {
      logger.warn({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        err: error && error.message,
        code: error && error.code,
        elapsed_ms: Date.now() - requestStartedAt,
        stage: error && error.stage ? error.stage : lastStage,
        stderr_bytes: error && Number.isFinite(Number(error.stderr_bytes)) ? Number(error.stderr_bytes) : 0,
        stderr_line_count: error && Number.isFinite(Number(error.stderr_line_count))
          ? Number(error.stderr_line_count)
          : 0,
        stderr_tail_hash: error && error.stderr_tail_hash ? error.stderr_tail_hash : "",
        stderr_tail_safe: error && error.stderr_tail_safe ? error.stderr_tail_safe : "",
        retry_stderr_line_count: error && Number.isFinite(Number(error.retry_stderr_line_count))
          ? Number(error.retry_stderr_line_count)
          : 0,
        retry_stderr_tail_hash: error && error.retry_stderr_tail_hash ? error.retry_stderr_tail_hash : "",
        retry_skip_reason: error && error.retry_skip_reason ? error.retry_skip_reason : "",
      }, "[openclaw-api] request failed");
      const reason = error && error.code ? error.code : "openclaw_execution_failed";
      const diagnostics = {
        request_id: requestId,
        reason_code: reason,
        attempt_mode: isCompactFirstRequest(payload) ? "compact_first" : "full_first",
        elapsed_ms: Date.now() - requestStartedAt,
        first_attempt_timeout_ms: effectiveFirstAttemptTimeoutMs ||
          firstAttemptTimeoutMs({ config, requestStartedAt }),
        error_code: error && (error.retry_error_code || error.code),
        initial_error_code: error && error.code,
        last_stage: error && error.stage ? error.stage : lastStage,
        retry_skip_reason: error && error.retry_skip_reason,
        stderr_tail_hash: error && error.stderr_tail_hash,
      };
      if (error && error.prompt) {
        diagnostics.prompt_chars = String(error.prompt).length;
      }
      if (error && Number.isFinite(Number(error.attempt_elapsed_ms))) {
        diagnostics.first_attempt_elapsed_ms = Number(error.attempt_elapsed_ms);
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_count")) {
        diagnostics.retry_count = error.retry_count;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_prompt_chars")) {
        diagnostics.retry_prompt_chars = error.retry_prompt_chars;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_elapsed_ms")) {
        diagnostics.retry_elapsed_ms = error.retry_elapsed_ms;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_last_stage")) {
        diagnostics.retry_last_stage = error.retry_last_stage;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_stdout_bytes")) {
        diagnostics.retry_stdout_bytes = error.retry_stdout_bytes;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_stderr_bytes")) {
        diagnostics.retry_stderr_bytes = error.retry_stderr_bytes;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_stderr_line_count")) {
        diagnostics.retry_stderr_line_count = error.retry_stderr_line_count;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_stderr_tail_hash")) {
        diagnostics.retry_stderr_tail_hash = error.retry_stderr_tail_hash;
      }
      if (error && Number.isFinite(Number(error.stdout_bytes))) {
        diagnostics.stdout_bytes = Number(error.stdout_bytes);
      }
      if (error && Number.isFinite(Number(error.stderr_bytes))) {
        diagnostics.stderr_bytes = Number(error.stderr_bytes);
      }
      if (error && Number.isFinite(Number(error.stderr_line_count))) {
        diagnostics.stderr_line_count = Number(error.stderr_line_count);
      }
      sendJson(res, 200, buildObserveResponse(reason, diagnostics));
    }
  });
};

const main = () => {
  const config = loadConfig();
  assertRuntimeConfig(config);
  const server = createServer({ config });
  server.listen(config.port, config.host, () => {
    console.info({
      host: config.host,
      port: config.port,
      workspaceDir: config.workspaceDir,
      agentMode: config.agentMode,
    }, "[openclaw-api] server started");
  });
};

if (require.main === module) {
  main();
}

module.exports = {
  buildMinimalRetryPayload,
  buildOptionalPromptFiles,
  buildPromptPayload,
  createServer,
  isCompactFirstRequest,
  readJsonBody,
};
