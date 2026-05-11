"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const { assertRuntimeConfig, loadConfig } = require("./config");
const {
  buildAgentPrompt,
  buildDirectAgentPrompt,
  buildDirectFailureResponse,
  buildObserveResponse,
  loadWorkspaceContext,
  parseAgentResponse,
  parseDirectAgentResponse,
} = require("./contracts");
const { createN8nDispatcher } = require("./n8n-dispatcher");
const { createNotionBridge, extractNotionId } = require("./notion-bridge");
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

const normalizeAuditIdentifier = (value, maxLength = 80) => {
  const text = String(value || "").trim();
  if (!text || /https?:\/\//i.test(text)) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|basic)[=/:]/i.test(text)) return "";
  if (/(?:^|[\s"'`({\[])(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i.test(text)) return "";
  if (/(?:^|[\s"'`({\[])(?:sk-proj-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,})/i.test(text)) return "";
  const normalized = text.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  if (/(?:bearer|basic)-[a-z0-9._~+/=-]{8,}/i.test(normalized)) return "";
  if (/(?:sk-proj-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,})/i.test(normalized)) return "";
  return normalized.slice(0, maxLength);
};

const normalizeAuditCode = (value, maxLength = 80) => {
  const text = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(text)) return "";
  return normalizeAuditIdentifier(text, maxLength);
};

const normalizeAuditCodeWithFallback = (value, fallback, maxLength = 80) =>
  normalizeAuditCode(value, maxLength) || normalizeAuditCode(fallback, maxLength) || "UNKNOWN";

const normalizeAuditNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;

const buildSafeRequestLogFields = ({ payload, requestId, directAgent, response, initialResponse, gateReason }) => {
  const conversation = payload && payload.context && payload.context.conversation ? payload.context.conversation : {};
  return {
    request_id: normalizeAuditIdentifier(requestId),
    channel_id: normalizeAuditIdentifier(payload && payload.channel && payload.channel.id, 40),
    execution_mode: directAgent ? "direct_agent" : "json_contract",
    action: normalizeAuditCode(response && response.action, 40),
    gate_reason: normalizeAuditCode(gateReason, 80),
    conversation_scope: normalizeAuditCode(conversation.scope, 40),
    conversation_used_messages: normalizeAuditNumber(conversation.used_messages),
    conversation_truncated: payload && payload.context && payload.context.conversation
      ? conversation.truncated === true
      : undefined,
    conversation_reason: normalizeAuditCode(conversation.reason, 80),
    conversation_error_code: normalizeAuditCode(conversation.error_code, 80),
    conversation_target_fetches: normalizeAuditNumber(conversation.target_fetches),
    conversation_target_fetch_failures: normalizeAuditNumber(conversation.target_fetch_failures),
    conversation_target_message_count: normalizeAuditNumber(conversation.target_message_count),
    notion_reads: Array.isArray(initialResponse && initialResponse.notion_requests) ? initialResponse.notion_requests.length : 0,
    notion_writes: Array.isArray(response && response.notion_writes) ? response.notion_writes.length : 0,
    n8n_workflow_requests: Array.isArray(initialResponse && initialResponse.n8n_workflow_requests)
      ? initialResponse.n8n_workflow_requests.length
      : 0,
  };
};

const buildRequestAuditRecord = ({ payload, requestId, directAgent, response, initialResponse, status, reason, gateReason, errorCode }) => ({
  ts: new Date().toISOString(),
  request_id: normalizeAuditIdentifier(requestId),
  channel_id: normalizeAuditIdentifier(payload && payload.channel && payload.channel.id, 40),
  channel_type: normalizeAuditCode(payload && payload.channel && payload.channel.type, 40),
  execution_mode: directAgent ? "direct_agent" : "json_contract",
  execution_reason: normalizeAuditCode(payload && payload.execution && payload.execution.reason, 80),
  status,
  action: normalizeAuditCode(response && response.action, 40),
  reason: normalizeAuditCode(reason || response && response.reason, 80),
  gate_reason: normalizeAuditCode(gateReason, 80),
  error_code: normalizeAuditCode(errorCode, 80),
  conversation_scope: normalizeAuditCode(
    payload && payload.context && payload.context.conversation && payload.context.conversation.scope,
    40
  ),
  conversation_reason: normalizeAuditCode(
    payload && payload.context && payload.context.conversation && payload.context.conversation.reason,
    80
  ),
  conversation_error_code: normalizeAuditCode(
    payload && payload.context && payload.context.conversation && payload.context.conversation.error_code,
    80
  ),
  conversation_used_messages: payload && payload.context && payload.context.conversation &&
    Number.isFinite(Number(payload.context.conversation.used_messages))
    ? Number(payload.context.conversation.used_messages)
    : undefined,
  conversation_truncated: payload && payload.context && payload.context.conversation
    ? payload.context.conversation.truncated === true
    : undefined,
  conversation_target_fetches: payload && payload.context && payload.context.conversation &&
    Number.isFinite(Number(payload.context.conversation.target_fetches))
    ? Number(payload.context.conversation.target_fetches)
    : undefined,
  conversation_target_fetch_failures: payload && payload.context && payload.context.conversation &&
    Number.isFinite(Number(payload.context.conversation.target_fetch_failures))
    ? Number(payload.context.conversation.target_fetch_failures)
    : undefined,
  conversation_target_message_count: payload && payload.context && payload.context.conversation &&
    Number.isFinite(Number(payload.context.conversation.target_message_count))
    ? Number(payload.context.conversation.target_message_count)
    : undefined,
  notion_reads: Array.isArray(initialResponse && initialResponse.notion_requests)
    ? initialResponse.notion_requests.length
    : 0,
  notion_writes: Array.isArray(response && response.notion_writes) ? response.notion_writes.length : 0,
  n8n_workflow_requests: Array.isArray(initialResponse && initialResponse.n8n_workflow_requests)
    ? initialResponse.n8n_workflow_requests.length
    : 0,
});

const writeRequestAudit = async ({ config, logger, record }) => {
  const auditPath = String(config && config.requestAuditPath || "").trim();
  if (!auditPath) return;
  try {
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn({
        request_id: record && record.request_id,
        error_code: normalizeAuditCodeWithFallback(
          error && (error.code || error.name),
          "REQUEST_AUDIT_WRITE_FAILED",
          64
        ),
      }, "[openclaw-api] request audit write failed");
    }
  }
};

const runOpenClawTurn = async ({ config, payload, workspaceContext, runAgentCommand }) => {
  const prompt = buildAgentPrompt({ payload, workspaceContext });
  const stdout = await runAgentCommand({ config, message: prompt });
  return parseAgentResponse(stdout);
};

const runDirectOpenClawTurn = async ({ config, payload, workspaceContext, runAgentCommand }) => {
  const prompt = buildDirectAgentPrompt({ payload, workspaceContext });
  const stdout = await runAgentCommand({ config, message: prompt });
  return parseDirectAgentResponse(stdout);
};

const isDirectAgentPayload = (payload) =>
  String(payload && payload.execution && payload.execution.mode || "").trim() === "direct_agent";

const isPrivateOrLocalHostname = (hostname) => {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (["localhost", "localhost.localdomain"].includes(normalized)) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const parts = normalized.split(".").map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 10 ||
      a === 127 ||
      a === 0 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168;
  }
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  ) return true;
  return false;
};

const hasSecretLikeUrlPart = (url) => {
  const source = `${url.pathname || ""} ${url.search || ""}`;
  return /(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|basic)[=/:]/i.test(source);
};

const isSafeDirectWebTarget = (target) => {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  try {
    const url = new URL(String(target.url || "").trim());
    if (!/^https?:$/.test(url.protocol)) return false;
    if (url.username || url.password) return false;
    if (String(url.href).length > 500) return false;
    if (isPrivateOrLocalHostname(url.hostname)) return false;
    if (hasSecretLikeUrlPart(url)) return false;
    const hostname = String(target.hostname || "").trim().toLowerCase();
    return !hostname || hostname === url.hostname.toLowerCase();
  } catch {
    return false;
  }
};

const isNotionUrl = (value) => {
  try {
    const url = new URL(String(value || "").replace(/[)\].,、。]+$/u, ""));
    const hostname = url.hostname.toLowerCase();
    return hostname === "notion.so" || hostname.endsWith(".notion.so") ||
      hostname === "notion.site" || hostname.endsWith(".notion.site");
  } catch {
    return false;
  }
};

const collectLinks = (content) => {
  const matches = String(content || "").match(/https?:\/\/\S+/g);
  return matches
    ? matches.map((link) => link.replace(/[)\].,、。]+$/u, "")).slice(0, 10)
    : [];
};

const validateDirectAgentPayload = (payload) => {
  const channelType = String(payload && payload.channel && payload.channel.type || "").trim();
  if (channelType !== "chat" && channelType !== "project") {
    return { ok: false, reason: "direct_channel_type_denied" };
  }
  const message = payload && payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
    ? payload.message
    : {};
  const content = String(message.content || "");
  if (/@everyone|@here/i.test(content) || message.mentions_everyone === true) {
    return { ok: false, reason: "direct_input_everyone_or_here" };
  }
  if (/<@&\d+>/i.test(content) || Array.isArray(message.role_mentions) && message.role_mentions.length > 0) {
    return { ok: false, reason: "direct_input_role_mention" };
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return { ok: false, reason: "direct_input_attachment" };
  }
  const webTargets = payload && payload.message && Array.isArray(payload.message.web_targets)
    ? payload.message.web_targets
    : [];
  const forwardedWebUrls = new Set(webTargets.map((target) => String(target && target.url || "")));
  const rawLinks = [
    ...(Array.isArray(message.links) ? message.links.map(String) : []),
    ...collectLinks(content),
  ].filter(Boolean);
  const nonNotionLinks = rawLinks.filter((link) => !isNotionUrl(link));
  if (nonNotionLinks.length > 0) {
    const explicitWebRequested = Boolean(payload && payload.context && payload.context.web && payload.context.web.explicit_requested);
    if (!explicitWebRequested) return { ok: false, reason: "direct_web_requires_explicit_request" };
    for (const link of nonNotionLinks) {
      const target = { url: link };
      if (!isSafeDirectWebTarget(target)) return { ok: false, reason: "direct_web_target_denied" };
      const normalizedUrl = new URL(link).href;
      if (!forwardedWebUrls.has(normalizedUrl)) return { ok: false, reason: "direct_web_target_mismatch" };
    }
  }
  if (webTargets.length > 0) {
    const explicitWebRequested = Boolean(payload && payload.context && payload.context.web && payload.context.web.explicit_requested);
    if (!explicitWebRequested) return { ok: false, reason: "direct_web_requires_explicit_request" };
    if (!webTargets.every(isSafeDirectWebTarget)) return { ok: false, reason: "direct_web_target_denied" };
  }
  return { ok: true, reason: "ok" };
};

const shouldExecuteWrites = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.explicit_write_requested);

const hasWriteTargetProvided = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.target_provided);

const hasDestructiveNotionRequest = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.destructive_request);

const hasNotionWorkIntent = (payload) => {
  const notion = payload && payload.context && payload.context.notion ? payload.context.notion : {};
  return Boolean(
    notion.explicit_write_requested ||
    notion.target_provided ||
    Array.isArray(notion.links) && notion.links.length > 0
  );
};

const buildNotionNoticeResponse = (reason, body) => ({
  ...buildObserveResponse(reason),
  action: "reply",
  body,
  confidence: "high",
});

const collectAllowedNotionTargetIds = (payload) => {
  const notion = payload && payload.context && payload.context.notion ? payload.context.notion : {};
  return new Set(
    (Array.isArray(notion.links) ? notion.links : [])
      .map(extractNotionId)
      .filter(Boolean)
  );
};

const requestTargetsAllowedPayloadTarget = ({ payload, request }) => {
  const allowedIds = collectAllowedNotionTargetIds(payload);
  if (allowedIds.size === 0) return false;
  const target = request && request.target ? request.target : {};
  const requestId = extractNotionId(target.id || target.page_id || target.data_source_id || target.database_id || target.url);
  return Boolean(requestId && allowedIds.has(requestId));
};

const shouldCheckReadTarget = (request) => {
  const operation = String(request && request.operation || "").trim();
  if (operation === "search") return false;
  const target = request && request.target ? request.target : {};
  return Boolean(target.id || target.page_id || target.data_source_id || target.database_id || target.url);
};

const normalizeToolResult = ({ result, fallbackOperation, fallbackReason }) =>
  result && typeof result === "object" && !Array.isArray(result)
    ? result
    : { ok: false, operation: fallbackOperation, reason: fallbackReason };

const executeNotionRound = async ({ payload, response, notionBridge, workspaceContext, config, runAgentCommand, logger }) => {
  if (hasDestructiveNotionRequest(payload)) {
    return buildNotionNoticeResponse(
      "notion_destructive_request_denied",
      "Notion の削除、アーカイブ、移動、複製はできません。必要なら、内容の確認や追記だけ手伝います。"
    );
  }
  if (!notionBridge || !notionBridge.enabled) return response;
  let nextResponse = response;
  if (Array.isArray(response.notion_requests) && response.notion_requests.length > 0) {
    const toolResults = [];
    for (const request of response.notion_requests.slice(0, 3)) {
      if (shouldCheckReadTarget(request) && !requestTargetsAllowedPayloadTarget({ payload, request })) {
        toolResults.push({
          id: request.id,
          ok: false,
          operation: request.operation,
          reason: "notion_read_target_mismatch",
        });
        continue;
      }
      const result = await notionBridge.runRead(request);
      toolResults.push({
        id: request.id,
        ...normalizeToolResult({
          result,
          fallbackOperation: request.operation,
          fallbackReason: "notion_read_invalid_result",
        }),
      });
    }
    const toolPayload = {
      ...payload,
      context: {
        ...(payload.context || {}),
        notion: {
          ...((payload.context && payload.context.notion) || {}),
          tool_results: toolResults,
        },
      },
    };
    nextResponse = await runOpenClawTurn({ config, payload: toolPayload, workspaceContext, runAgentCommand });
  }

  if (Array.isArray(nextResponse.notion_writes) && nextResponse.notion_writes.length > 0) {
    if (!shouldExecuteWrites(payload)) {
      return {
        ...buildObserveResponse("notion_write_requires_explicit_request"),
        notion_writes: nextResponse.notion_writes,
      };
    }
    if (!hasWriteTargetProvided(payload)) {
      return buildNotionNoticeResponse(
        "notion_write_target_required",
        "書き込み先の Notion ページがまだ分かりません。対象の Notion URL を送ってください。"
      );
    }
    const writeResults = [];
    for (const request of nextResponse.notion_writes.slice(0, 3)) {
      if (!requestTargetsAllowedPayloadTarget({ payload, request })) {
        writeResults.push({
          id: request.id,
          ok: false,
          operation: request.operation,
          reason: "notion_write_target_mismatch",
        });
        continue;
      }
      const result = await notionBridge.runWrite(request);
      writeResults.push({
        id: request.id,
        ...normalizeToolResult({
          result,
          fallbackOperation: request.operation,
          fallbackReason: "notion_write_invalid_result",
        }),
      });
    }
    const failed = writeResults.find((result) => !result.ok);
    if (failed) {
      if (logger && typeof logger.warn === "function") {
        logger.warn({
          request_id: normalizeAuditIdentifier(payload.request_id),
          notion_operation: normalizeAuditCode(failed.operation, 40),
          notion_reason: normalizeAuditCode(failed.reason, 80),
        }, "[openclaw-api] notion write denied or failed");
      }
      return {
        ...buildObserveResponse(failed.reason || "notion_write_failed"),
        notion_writes: nextResponse.notion_writes,
      };
    }
    return {
      ...nextResponse,
      notion_write_results: writeResults,
    };
  }
  return nextResponse;
};

const buildN8nNoticeResponse = (reason, body) => ({
  ...buildObserveResponse(reason),
  action: "reply",
  body,
  confidence: "medium",
});

const isN8nWriteOperation = (request) =>
  ["notion.create_page", "notion.append_blocks"].includes(String(request && request.operation || "").trim());

const isN8nTargetedReadOperation = (request) =>
  ["notion.retrieve_page", "notion.retrieve_block_children", "notion.query_data_source"].includes(
    String(request && request.operation || "").trim()
  );

const requestHasTarget = (request) => {
  const target = request && request.target ? request.target : {};
  return Boolean(target.id || target.page_id || target.data_source_id || target.database_id || target.url);
};

const validateN8nWorkflowRequestForPayload = ({ payload, request }) => {
  if (String(request && request.workflow_key || "") !== "notion.safe_ops") {
    return { ok: false, reason: "n8n_workflow_not_allowed" };
  }
  if (isN8nWriteOperation(request)) {
    if (!shouldExecuteWrites(payload)) return { ok: false, reason: "notion_write_requires_explicit_request" };
    if (!hasWriteTargetProvided(payload)) return { ok: false, reason: "notion_write_target_required" };
    if (!requestHasTarget(request)) return { ok: false, reason: "notion_write_target_required" };
    if (!requestTargetsAllowedPayloadTarget({ payload, request })) {
      return { ok: false, reason: "notion_write_target_mismatch" };
    }
  }
  if (isN8nTargetedReadOperation(request) && requestHasTarget(request) && !requestTargetsAllowedPayloadTarget({ payload, request })) {
    return { ok: false, reason: "notion_read_target_mismatch" };
  }
  return { ok: true, reason: "ok" };
};

const executeN8nWorkflowRound = async ({ payload, response, n8nDispatcher, logger }) => {
  const requests = Array.isArray(response.n8n_workflow_requests) ? response.n8n_workflow_requests : [];
  if (requests.length === 0) {
    if (hasNotionWorkIntent(payload)) {
      return buildN8nNoticeResponse(
        "n8n_workflow_request_missing",
        "Notion 作業を n8n workflow に渡す依頼を作れませんでした。対象と作業内容をもう一度短く教えてください。"
      );
    }
    return response;
  }
  const safeReplies = [];
  const workflowResults = [];
  for (const request of requests.slice(0, 3)) {
    const validation = validateN8nWorkflowRequestForPayload({ payload, request });
    if (!validation.ok) {
      return buildN8nNoticeResponse(validation.reason, "Notion の対象または実行条件を確認できなかったため、作業を止めました。");
    }
    const result = await n8nDispatcher.run({ payload, request });
    workflowResults.push({
      id: request.id,
      workflow_key: request.workflow_key,
      operation: request.operation,
      ok: result.ok,
      reason: result.reason,
      results: result.results,
    });
    if (!result.ok) {
      if (logger && typeof logger.warn === "function") {
        logger.warn({
          request_id: normalizeAuditIdentifier(payload.request_id),
          workflow_key: normalizeAuditCode(request.workflow_key, 80),
          operation: normalizeAuditCode(request.operation, 80),
          reason: normalizeAuditCode(result.reason, 80),
        }, "[openclaw-api] n8n workflow dispatch failed");
      }
      return buildN8nNoticeResponse(result.reason, result.safe_reply);
    }
    if (result.safe_reply) safeReplies.push(result.safe_reply);
  }
  return {
    ...response,
    body: safeReplies.length > 0 ? safeReplies.join("\n").slice(0, 1600) : response.body,
    n8n_workflow_results: workflowResults,
  };
};

const createServer = ({
  config = loadConfig(),
  logger = console,
  runAgentCommand = runOpenClawAgent,
  loadContext = loadWorkspaceContext,
  notionBridge = createNotionBridge({ config, logger }),
  n8nDispatcher = createN8nDispatcher({ config }),
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
    try {
      const workspaceContext = await loadContext({
        workspaceDir: config.workspaceDir,
        promptFiles: config.promptFiles,
      });
      const directAgent = isDirectAgentPayload(payload);
      if (directAgent) {
        const directGate = validateDirectAgentPayload(payload);
        if (!directGate.ok) {
          const response = buildObserveResponse(directGate.reason);
          logger.info({
            ...buildSafeRequestLogFields({
              payload,
              requestId,
              directAgent,
              response,
              initialResponse: null,
              gateReason: directGate.reason,
            }),
          }, "[openclaw-api] request completed");
          await writeRequestAudit({
            config,
            logger,
            record: buildRequestAuditRecord({
              payload,
              requestId,
              directAgent,
              response,
              initialResponse: null,
              status: "blocked",
              gateReason: directGate.reason,
            }),
          });
          sendJson(res, 200, response);
          return;
        }
      }
      if (directAgent && hasDestructiveNotionRequest(payload)) {
        const response = buildNotionNoticeResponse(
          "notion_destructive_request_denied",
          "Notion の削除、アーカイブ、移動、複製はできません。必要なら、内容の確認や追記だけ手伝います。"
        );
        logger.info({
          ...buildSafeRequestLogFields({
            payload,
            requestId,
            directAgent,
            response,
            initialResponse: null,
          }),
        }, "[openclaw-api] request completed");
        await writeRequestAudit({
          config,
          logger,
          record: buildRequestAuditRecord({
            payload,
            requestId,
            directAgent,
            response,
            initialResponse: null,
            status: "blocked",
            reason: response.reason,
          }),
        });
        sendJson(res, 200, response);
        return;
      }
      const initialResponse = directAgent
        ? await runDirectOpenClawTurn({ config, payload, workspaceContext, runAgentCommand })
        : await runOpenClawTurn({ config, payload, workspaceContext, runAgentCommand });
      const response = directAgent
        ? await executeN8nWorkflowRound({
            payload,
            response: initialResponse,
            n8nDispatcher,
            logger,
          })
        : await executeNotionRound({
            payload,
            response: initialResponse,
            notionBridge,
            workspaceContext,
            config,
            runAgentCommand,
            logger,
          });
      logger.info({
        ...buildSafeRequestLogFields({
          payload,
          requestId,
          directAgent,
          response,
          initialResponse,
        }),
      }, "[openclaw-api] request completed");
      await writeRequestAudit({
        config,
        logger,
        record: buildRequestAuditRecord({
          payload,
          requestId,
          directAgent,
          response,
          initialResponse,
          status: "completed",
        }),
      });
      sendJson(res, 200, response);
    } catch (error) {
      const failureResponse = isDirectAgentPayload(payload)
        ? buildDirectFailureResponse(error)
        : buildObserveResponse(error && error.code ? error.code : "openclaw_execution_failed");
      logger.warn({
        request_id: normalizeAuditIdentifier(requestId),
        channel_id: normalizeAuditIdentifier(payload && payload.channel && payload.channel.id, 40),
        error_code: normalizeAuditCodeWithFallback(
          error && (error.code || error.name),
          "OPENCLAW_EXECUTION_FAILED",
          64
        ),
      }, "[openclaw-api] request failed");
      await writeRequestAudit({
        config,
        logger,
        record: buildRequestAuditRecord({
          payload,
          requestId,
          directAgent: isDirectAgentPayload(payload),
          response: failureResponse,
          initialResponse: null,
          status: "failed",
          reason: error && error.code ? error.code : "openclaw_execution_failed",
          errorCode: error && (error.code || error.name),
        }),
      });
      sendJson(res, 200, failureResponse);
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
  buildRequestAuditRecord,
  createServer,
  readJsonBody,
  writeRequestAudit,
};
