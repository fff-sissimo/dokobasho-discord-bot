"use strict";

const crypto = require("node:crypto");

const READ_OPERATIONS = new Set(["retrieve_page", "retrieve_block_children", "query_data_source"]);
const WRITE_OPERATIONS = new Set(["create_page", "append_blocks"]);
const BLOCKED_OPERATION_PATTERN = /delete|archive|trash|move|duplicate|erase|remove/i;

const normalizeText = (value, maxLength = 4000) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const hashIdentifier = (value) =>
  crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);

const extractNotionId = (value) => {
  const source = String(value || "").trim();
  if (!source) return "";
  const compactUuid = source.match(/[0-9a-f]{32}/i);
  if (compactUuid) {
    const id = compactUuid[0].toLowerCase();
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  const uuid = source.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0].toLowerCase() : "";
};

const normalizeTarget = (target = {}) => {
  const source = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  const id = extractNotionId(source.id || source.page_id || source.data_source_id || source.database_id || source.url);
  const rawType = String(source.type || source.parent_type || "").trim().toLowerCase();
  const type = rawType === "database" ? "data_source" : rawType;
  return {
    id,
    type: type === "data_source" || type === "page" || type === "block" ? type : "",
    url_present: Boolean(String(source.url || "").trim()),
  };
};

const isBlockedOperation = (operation) => BLOCKED_OPERATION_PATTERN.test(String(operation || ""));

const sanitizeResult = (value, maxChars) => {
  let remaining = Math.max(500, Number(maxChars) || 4000);
  const prune = (item, depth = 0) => {
    if (remaining <= 0) return "[truncated]";
    if (item === null || item === undefined) return item;
    if (typeof item === "string") {
      const text = normalizeText(item, Math.min(remaining, 1000));
      remaining -= text.length;
      return text;
    }
    if (typeof item === "number" || typeof item === "boolean") return item;
    if (depth >= 8) return "[max_depth]";
    if (Array.isArray(item)) {
      const output = [];
      for (const entry of item.slice(0, 20)) {
        if (remaining <= 0) break;
        output.push(prune(entry, depth + 1));
      }
      if (item.length > output.length) output.push(`[truncated:${item.length - output.length}]`);
      return output;
    }
    if (typeof item === "object") {
      const output = {};
      for (const [key, entry] of Object.entries(item).slice(0, 50)) {
        if (remaining <= 0) {
          output.__truncated = true;
          break;
        }
        output[key] = prune(entry, depth + 1);
      }
      return output;
    }
    return String(item);
  };
  return prune(value);
};

const titleToRichText = (title) => [
  {
    type: "text",
    text: { content: normalizeText(title, 200) || "Untitled" },
  },
];

const bodyToParagraphBlocks = (body) =>
  String(body || "")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeText(paragraph, 1800))
    .filter(Boolean)
    .slice(0, 20)
    .map((paragraph) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: paragraph } }] },
    }));

const createNotionBridge = ({ config = {}, fetchImpl = fetch, logger = console } = {}) => {
  const notionConfig = config.notion || {};
  const enabled = Boolean(notionConfig.enabled);
  const token = String(notionConfig.token || "").trim();
  const baseUrl = String(notionConfig.baseUrl || "https://api.notion.com/v1").replace(/\/+$/, "");
  const version = String(notionConfig.version || "2025-09-03").trim();
  const maxResults = Math.max(1, Math.min(Number(notionConfig.maxResults) || 5, 10));
  const maxResultChars = Math.max(500, Math.min(Number(notionConfig.maxResultChars) || 4000, 12000));

  const request = async (path, { method = "GET", body } = {}) => {
    if (!enabled) {
      const error = new Error("Notion bridge disabled");
      error.code = "NOTION_DISABLED";
      throw error;
    }
    if (!token) {
      const error = new Error("Notion token missing");
      error.code = "NOTION_TOKEN_MISSING";
      throw error;
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "notion-version": version,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 1000) };
    }
    if (!response.ok) {
      const error = new Error(`Notion request failed: status=${response.status}`);
      error.code = "NOTION_REQUEST_FAILED";
      error.status = response.status;
      error.body = sanitizeResult(json, 1000);
      throw error;
    }
    return json;
  };

  const runRead = async (rawRequest = {}) => {
    const operation = String(rawRequest.operation || "").trim();
    if (!READ_OPERATIONS.has(operation) || isBlockedOperation(operation)) {
      return { ok: false, operation, reason: "notion_read_operation_denied" };
    }
    const target = normalizeTarget(rawRequest.target);
    const pageSize = Math.max(1, Math.min(Number(rawRequest.page_size) || maxResults, maxResults));
    try {
      if (!target.id) return { ok: false, operation, reason: "notion_target_required" };
      if (operation === "retrieve_page") {
        return { ok: true, operation, target_id_hash: hashIdentifier(target.id), result: sanitizeResult(await request(`/pages/${target.id}`), maxResultChars) };
      }
      if (operation === "retrieve_block_children") {
        return {
          ok: true,
          operation,
          target_id_hash: hashIdentifier(target.id),
          result: sanitizeResult(await request(`/blocks/${target.id}/children?page_size=${pageSize}`), maxResultChars),
        };
      }
      if (operation === "query_data_source") {
        return {
          ok: true,
          operation,
          target_id_hash: hashIdentifier(target.id),
          result: sanitizeResult(await request(`/data_sources/${target.id}/query`, {
            method: "POST",
            body: { page_size: pageSize },
          }), maxResultChars),
        };
      }
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn({ err: error && error.message, code: error && error.code, operation }, "[openclaw-api] notion read failed");
      }
      return { ok: false, operation, reason: error && error.code || "notion_read_failed", status: error && error.status };
    }
    return { ok: false, operation, reason: "notion_read_not_implemented" };
  };

  const runWrite = async (rawRequest = {}) => {
    const operation = String(rawRequest.operation || "").trim();
    if (!WRITE_OPERATIONS.has(operation) || isBlockedOperation(operation)) {
      return { ok: false, operation, reason: "notion_write_operation_denied" };
    }
    if (rawRequest.archived === true || rawRequest.in_trash === true || rawRequest.erase_content === true) {
      return { ok: false, operation, reason: "notion_destructive_write_denied" };
    }
    const target = normalizeTarget(rawRequest.target);
    if (!target.id) return { ok: false, operation, reason: "notion_target_required" };
    try {
      if (operation === "create_page") {
        const parentType = target.type === "data_source" ? "data_source_id" : "page_id";
        const result = await request("/pages", {
          method: "POST",
          body: {
            parent: { [parentType]: target.id },
            properties: {
              title: {
                title: titleToRichText(rawRequest.title),
              },
            },
            children: bodyToParagraphBlocks(rawRequest.body),
          },
        });
        return { ok: true, operation, target_id_hash: hashIdentifier(target.id), page_id: result.id, url: result.url };
      }
      if (operation === "append_blocks") {
        const blocks = bodyToParagraphBlocks(rawRequest.body);
        if (blocks.length === 0) return { ok: false, operation, reason: "notion_empty_body" };
        const result = await request(`/blocks/${target.id}/children`, {
          method: "PATCH",
          body: { children: blocks },
        });
        return { ok: true, operation, target_id_hash: hashIdentifier(target.id), appended_blocks: blocks.length, result_id: result.id || "" };
      }
    } catch (error) {
      if (logger && typeof logger.warn === "function") {
        logger.warn({ err: error && error.message, code: error && error.code, operation }, "[openclaw-api] notion write failed");
      }
      return { ok: false, operation, reason: error && error.code || "notion_write_failed", status: error && error.status };
    }
    return { ok: false, operation, reason: "notion_write_not_implemented" };
  };

  return {
    enabled,
    runRead,
    runWrite,
  };
};

module.exports = {
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  createNotionBridge,
  extractNotionId,
  normalizeTarget,
};
