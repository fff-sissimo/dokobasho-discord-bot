"use strict";

const { normalizeDirectReplyText } = require("./contracts");

const DEFAULT_MAX_RESPONSE_CHARS = 1600;

const normalizeList = (value) => Array.isArray(value)
  ? value.map((item) => String(item).trim()).filter(Boolean)
  : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

const sanitizeReasonCode = (value) =>
  String(value || "n8n_dispatch_failed")
    .replace(/(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[^\s]+/gi, "secret_redacted")
    .replace(/[^a-z0-9_:-]+/gi, "_")
    .slice(0, 80);

const buildSafeFailure = (reason) => ({
  ok: false,
  reason: sanitizeReasonCode(reason),
  safe_reply: "-# n8n workflow を実行できませんでした。時間をおいてもう一度試してください。",
  results: [],
});

const pickSafeDiscordMetadata = (payload) => ({
  guild_id: String(payload && payload.guild_id || ""),
  channel_id: String(payload && payload.channel && payload.channel.id || ""),
  channel_type: String(payload && payload.channel && payload.channel.type || ""),
  thread_id: String(payload && payload.channel && payload.channel.thread_id || ""),
  parent_channel_id: String(payload && payload.channel && payload.channel.parent_channel_id || ""),
  message_id: String(payload && payload.message && payload.message.id || ""),
  author_id: String(payload && payload.message && payload.message.author_id || ""),
});

const buildDispatchPayload = ({ payload, request }) => ({
  schema_version: 1,
  source: "openclaw-api",
  request_id: String(payload && payload.request_id || ""),
  workflow_key: request.workflow_key,
  operation: request.operation,
  dispatch_request: {
    id: request.id,
    workflow_key: request.workflow_key,
    operation: request.operation,
    target: request.target || {},
    input: request.input || {},
  },
  discord: pickSafeDiscordMetadata(payload),
  context: {
    notion: payload && payload.context && payload.context.notion
      ? {
          links: Array.isArray(payload.context.notion.links) ? payload.context.notion.links.slice(0, 5) : [],
          explicit_write_requested: payload.context.notion.explicit_write_requested === true,
          target_provided: payload.context.notion.target_provided === true,
        }
      : {},
    web: payload && payload.context && payload.context.web
      ? {
          explicit_requested: payload.context.web.explicit_requested === true,
          targets: Array.isArray(payload.context.web.targets) ? payload.context.web.targets.slice(0, 5) : [],
        }
      : {},
  },
});

const parseResponseJson = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, reason: "n8n_invalid_json_response" };
  }
};

const normalizeDispatchResponse = (value, fallbackReason = "n8n_dispatch_failed") => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const safeReply = normalizeDirectReplyText(source.safe_reply || source.body || source.message || "");
  const results = Array.isArray(source.results)
    ? source.results.slice(0, 3).map((result) => {
        const item = result && typeof result === "object" && !Array.isArray(result) ? result : {};
        return {
          id: String(item.id || "").slice(0, 80),
          workflow_key: String(item.workflow_key || "").slice(0, 80),
          operation: String(item.operation || "").slice(0, 80),
          status: String(item.status || (item.ok === false ? "error" : "ok")).slice(0, 40),
          target_id: String(item.target_id || "").slice(0, 120),
          target_title: String(item.target_title || "").replace(/\s+/g, " ").trim().slice(0, 200),
          channel_id: String(item.channel_id || "").slice(0, 40),
          thread_id: String(item.thread_id || "").slice(0, 40),
          message_id: String(item.message_id || "").slice(0, 40),
          summary: normalizeDirectReplyText(item.summary || item.result_summary || "").slice(0, 400),
          reason: String(item.reason || "").replace(/[^a-z0-9_:-]+/gi, "_").slice(0, 80),
        };
      })
    : [];
  return {
    ok: source.ok !== false,
    reason: sanitizeReasonCode(source.reason || fallbackReason),
    safe_reply: safeReply.slice(0, DEFAULT_MAX_RESPONSE_CHARS),
    results,
  };
};

const createN8nDispatcher = ({ config, fetchImpl = fetch } = {}) => {
  const settings = config && config.n8nDispatch ? config.n8nDispatch : {};
  const allowedWorkflows = new Set(normalizeList(settings.allowedWorkflows || "notion.safe_ops"));
  const enabled = settings.enabled === true;
  const url = String(settings.url || "").trim();
  const workflowUrls = settings.workflowUrls && typeof settings.workflowUrls === "object" && !Array.isArray(settings.workflowUrls)
    ? settings.workflowUrls
    : {};
  const secret = String(settings.secret || "").trim();
  const timeoutMs = Number(settings.timeoutMs || 20000);

  const run = async ({ payload, request }) => {
    if (!enabled) return buildSafeFailure("n8n_dispatch_disabled");
    const requestUrl = String(workflowUrls[request.workflow_key] || url || "").trim();
    if (!requestUrl || !secret) return buildSafeFailure("n8n_dispatch_not_configured");
    if (!allowedWorkflows.has(request.workflow_key)) return buildSafeFailure("n8n_workflow_not_allowed");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": secret,
        },
        body: JSON.stringify(buildDispatchPayload({ payload, request })),
        signal: controller.signal,
      });
      const json = await parseResponseJson(response);
      if (!response.ok) {
        return normalizeDispatchResponse({
          ok: false,
          reason: json.reason || `n8n_http_${response.status}`,
          safe_reply: json.safe_reply,
          results: json.results,
        }, `n8n_http_${response.status}`);
      }
      return normalizeDispatchResponse(json, "n8n_dispatch_completed");
    } catch (error) {
      const reason = error && error.name === "AbortError" ? "n8n_dispatch_timeout" : "n8n_dispatch_failed";
      return buildSafeFailure(reason);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    enabled,
    run,
  };
};

module.exports = {
  buildDispatchPayload,
  createN8nDispatcher,
  normalizeDispatchResponse,
};
