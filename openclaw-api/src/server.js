"use strict";

const http = require("node:http");

const { assertRuntimeConfig, loadConfig } = require("./config");
const {
  buildAgentPrompt,
  buildObserveResponse,
  loadWorkspaceContext,
  parseAgentResponse,
} = require("./contracts");
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

const runOpenClawTurn = async ({ config, payload, workspaceContext, runAgentCommand }) => {
  const prompt = buildAgentPrompt({ payload, workspaceContext });
  const stdout = await runAgentCommand({ config, message: prompt });
  return parseAgentResponse(stdout);
};

const shouldExecuteWrites = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.explicit_write_requested);

const hasWriteTargetProvided = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.target_provided);

const hasDestructiveNotionRequest = (payload) =>
  Boolean(payload && payload.context && payload.context.notion && payload.context.notion.destructive_request);

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
          request_id: payload.request_id,
          notion_operation: failed.operation,
          notion_reason: failed.reason,
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

const createServer = ({
  config = loadConfig(),
  logger = console,
  runAgentCommand = runOpenClawAgent,
  loadContext = loadWorkspaceContext,
  notionBridge = createNotionBridge({ config, logger }),
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
      const initialResponse = await runOpenClawTurn({ config, payload, workspaceContext, runAgentCommand });
      const response = await executeNotionRound({
        payload,
        response: initialResponse,
        notionBridge,
        workspaceContext,
        config,
        runAgentCommand,
        logger,
      });
      logger.info({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        action: response.action,
        notion_reads: Array.isArray(initialResponse.notion_requests) ? initialResponse.notion_requests.length : 0,
        notion_writes: Array.isArray(response.notion_writes) ? response.notion_writes.length : 0,
      }, "[openclaw-api] request completed");
      sendJson(res, 200, response);
    } catch (error) {
      logger.warn({
        request_id: requestId,
        channel_id: payload.channel && payload.channel.id,
        err: error && error.message,
        code: error && error.code,
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
  createServer,
  readJsonBody,
};
