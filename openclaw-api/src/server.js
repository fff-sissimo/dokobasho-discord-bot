"use strict";

const http = require("node:http");

const { assertRuntimeConfig, loadConfig } = require("./config");
const {
  buildAgentPrompt,
  buildObserveResponse,
  loadWorkspaceContext,
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

const RETRY_MESSAGE_CONTENT_MAX_CHARS = 500;
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

const buildMinimalRetryPayload = (payload) => {
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
    },
    message: {
      id: String(message.id || "").trim(),
      author_id: String(message.author_id || "").trim(),
      content: String(message.content || "").slice(0, RETRY_MESSAGE_CONTENT_MAX_CHARS),
      created_at: String(message.created_at || "").trim(),
      is_reply_to_bot: Boolean(message.is_reply_to_bot),
      mentions_bot: Boolean(message.mentions_bot),
      mentions_everyone: Boolean(message.mentions_everyone),
      role_mentions: normalizeRetryIdentifierList(message.role_mentions),
      attachments: normalizeRetryAttachments(message.attachments),
      links: normalizeRetryLinks(message.links),
    },
    context: {
      recent_messages: [],
      active_thread_age_minutes: context.active_thread_age_minutes ?? null,
      has_promised_followup: Boolean(context.has_promised_followup),
      matched_followup_ids: normalizeRetryIdentifierList(context.matched_followup_ids),
    },
  };
};

const executeOpenClawPrompt = async ({ config, payload, workspaceContext, runAgentCommand }) => {
  const prompt = buildAgentPrompt({ payload, workspaceContext });
  const stdout = await runAgentCommand({ config, message: prompt });
  return {
    prompt,
    response: parseAgentResponse(stdout),
  };
};

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
    try {
      const workspaceContext = await loadContext({
        workspaceDir: config.workspaceDir,
        promptFiles: config.promptFiles,
        maxChars: config.maxWorkspaceContextChars,
      });
      let result = await executeOpenClawPrompt({ config, payload, workspaceContext, runAgentCommand });
      const initialPromptChars = result.prompt.length;
      let retryCount = 0;
      let retryPromptChars = 0;
      if (result.response.action === "observe" && result.response.reason === "context_overflow") {
        const retryPayload = buildMinimalRetryPayload(payload);
        result = await executeOpenClawPrompt({
          config,
          payload: retryPayload,
          workspaceContext: "",
          runAgentCommand,
        });
        retryCount = 1;
        retryPromptChars = result.prompt.length;
      }
      const response = result.response;
      logger.info({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        action: response.action,
        reason: safeLogIdentifier(response.reason),
        confidence: safeLogText(response.confidence, { maxLength: 24 }),
        body_len: typeof response.body === "string" ? response.body.length : 0,
        elapsed_ms: Date.now() - requestStartedAt,
        prompt_chars: result.prompt.length,
        initial_prompt_chars: initialPromptChars,
        retry_count: retryCount,
        retry_prompt_chars: retryPromptChars,
        workspace_context_chars: workspaceContext.length,
      }, "[openclaw-api] request completed");
      sendJson(res, 200, response);
    } catch (error) {
      logger.warn({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        err: error && error.message,
        code: error && error.code,
        elapsed_ms: Date.now() - requestStartedAt,
      }, "[openclaw-api] request failed");
      sendJson(res, 200, buildObserveResponse(error && error.code ? error.code : "openclaw_execution_failed"));
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
  createServer,
  readJsonBody,
};
