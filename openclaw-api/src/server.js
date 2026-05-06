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

const executeOpenClawPrompt = async ({
  config,
  payload,
  workspaceContext,
  runAgentCommand,
  projectPayload = true,
  timeoutMs,
  promptBuilder = buildAgentPrompt,
  sessionAttempt,
}) => {
  const promptPayload = projectPayload ? buildPromptPayload(payload) : payload;
  const prompt = promptBuilder({ payload: promptPayload, workspaceContext });
  let stdout;
  try {
    stdout = await runAgentCommand({ config, message: prompt, timeoutMs, sessionAttempt });
  } catch (error) {
    if (error && typeof error === "object") {
      error.prompt = prompt;
    }
    throw error;
  }
  return {
    prompt,
    response: parseAgentResponse(stdout),
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
    try {
      const compactFirst = isCompactFirstRequest(payload);
      const attemptMode = compactFirst ? "compact_first" : "full_first";
      const workspaceContext = compactFirst
        ? ""
        : await loadContext({
          workspaceDir: config.workspaceDir,
          promptFiles: config.promptFiles,
          maxChars: config.maxWorkspaceContextChars,
          required: true,
        });
      const firstTimeoutMs = firstAttemptTimeoutMs({ config, requestStartedAt });
      effectiveFirstAttemptTimeoutMs = firstTimeoutMs;
      if (firstTimeoutMs <= 0) throw buildTimeoutError();
      let result;
      let initialPromptChars = 0;
      let retryCount = 0;
      let retryPromptChars = 0;
      let retryErrorCode = "";
      let initialError = null;
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
          });
        } else {
          result = await executeOpenClawPrompt({
            config,
            payload,
            workspaceContext,
            runAgentCommand,
            timeoutMs: firstTimeoutMs,
          });
        }
        initialPromptChars = result.prompt.length;
      } catch (error) {
        initialError = error;
        initialPromptChars = error && error.prompt ? String(error.prompt).length : 0;
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
        if (retryTimeoutMs >= config.retryMinTimeoutMs) {
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
            });
            retryPromptChars = result.prompt.length;
          } catch (error) {
            retryErrorCode = error && error.code ? error.code : "openclaw_execution_failed";
            retryPromptChars = error && error.prompt ? String(error.prompt).length : 0;
          }
        }
      }
      if (initialError) {
        const retryTimeoutMs = remainingRequestTimeoutMs({ config, requestStartedAt });
        if (retryTimeoutMs >= config.retryMinTimeoutMs) {
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
            });
            retryPromptChars = result.prompt.length;
          } catch (error) {
            retryErrorCode = error && error.code ? error.code : "openclaw_execution_failed";
            retryPromptChars = error && error.prompt ? String(error.prompt).length : 0;
            if (initialError && typeof initialError === "object") {
              initialError.retry_count = retryCount;
              initialError.retry_prompt_chars = retryPromptChars;
              initialError.retry_error_code = retryErrorCode;
            }
            throw initialError;
          }
        } else {
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
        retry_count: retryCount,
        retry_prompt_chars: retryPromptChars,
        workspace_context_chars: workspaceContext.length,
      };
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
        retry_count: metrics.retry_count,
        retry_prompt_chars: metrics.retry_prompt_chars,
        attempt_mode: metrics.attempt_mode,
        first_attempt_timeout_ms: metrics.first_attempt_timeout_ms,
        workspace_context_chars: metrics.workspace_context_chars,
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
      };
      if (error && error.prompt) {
        diagnostics.prompt_chars = String(error.prompt).length;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_count")) {
        diagnostics.retry_count = error.retry_count;
      }
      if (error && Object.prototype.hasOwnProperty.call(error, "retry_prompt_chars")) {
        diagnostics.retry_prompt_chars = error.retry_prompt_chars;
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
  buildPromptPayload,
  createServer,
  isCompactFirstRequest,
  readJsonBody,
};
