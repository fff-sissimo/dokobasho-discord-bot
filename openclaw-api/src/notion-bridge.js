"use strict";

const crypto = require("node:crypto");

const READ_OPERATIONS = new Set(["retrieve_page", "retrieve_block_children", "query_data_source", "search"]);
const WRITE_OPERATIONS = new Set(["create_page", "append_blocks"]);
const BLOCKED_OPERATION_PATTERN = /delete|archive|trash|move|duplicate|erase|remove/i;
const NOTION_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "divider",
]);

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
  let type = rawType;
  if (type === "database_id") type = "database";
  if (type === "data_source_id") type = "data_source";
  if (type === "page_id") type = "page";
  if (type === "block_id") type = "block";
  if (!type && source.database_id) type = "database";
  if (!type && source.data_source_id) type = "data_source";
  if (!type && source.page_id) type = "page";
  return {
    id,
    type: type === "database" || type === "data_source" || type === "page" || type === "block" ? type : "",
    url_present: Boolean(String(source.url || "").trim()),
    database_id_present: Boolean(String(source.database_id || "").trim()),
    data_source_id_present: Boolean(String(source.data_source_id || "").trim()),
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

const textToRichText = (text, maxLength = 1800) => {
  const content = normalizeText(text, maxLength);
  return content ? [{ type: "text", text: { content } }] : [];
};

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

const normalizeBlockType = (value) => {
  const type = String(value || "paragraph").trim().toLowerCase();
  return NOTION_BLOCK_TYPES.has(type) ? type : "paragraph";
};

const extractBlockText = (block, type) => {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.body === "string") return block.body;
  if (typeof block.plain_text === "string") return block.plain_text;
  const typed = block[type] && typeof block[type] === "object" && !Array.isArray(block[type]) ? block[type] : {};
  if (Array.isArray(typed.rich_text)) {
    return typed.rich_text.map((item) => item && (item.plain_text || (item.text && item.text.content)) || "").join(" ");
  }
  return "";
};

const blockToNotionBlock = (block) => {
  const source = block && typeof block === "object" && !Array.isArray(block) ? block : {};
  const type = normalizeBlockType(source.type);
  if (type === "divider") {
    return { object: "block", type: "divider", divider: {} };
  }
  const richText = textToRichText(extractBlockText(block, type));
  if (richText.length === 0) return null;
  const output = {
    object: "block",
    type,
    [type]: { rich_text: richText },
  };
  if (type === "to_do") {
    output.to_do.checked = Boolean(source.checked);
  }
  if (type === "callout") {
    const emoji = normalizeText(source.emoji || (source.icon && source.icon.emoji) || "", 16);
    if (emoji) output.callout.icon = { type: "emoji", emoji };
  }
  return output;
};

const blocksToNotionBlocks = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .map(blockToNotionBlock)
    .filter(Boolean)
    .slice(0, 20);

const requestError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const findTitlePropertyName = (dataSource) => {
  const properties = dataSource && dataSource.properties && typeof dataSource.properties === "object" && !Array.isArray(dataSource.properties)
    ? dataSource.properties
    : {};
  const match = Object.entries(properties).find(([, property]) =>
    property && typeof property === "object" && (property.type === "title" || Object.prototype.hasOwnProperty.call(property, "title")));
  return match ? match[0] : "title";
};

const buildChildren = (rawRequest) => {
  const blocks = blocksToNotionBlocks(rawRequest.blocks);
  return blocks.length > 0 ? blocks : bodyToParagraphBlocks(rawRequest.body);
};

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

  const resolveSingleDataSource = async (target) => {
    if (!target.id) throw requestError("NOTION_TARGET_REQUIRED", "Notion target required");
    const shouldTryDatabase = target.type === "database" || target.database_id_present || target.url_present;
    if (shouldTryDatabase) {
      let databaseMatched = false;
      try {
        const database = await request(`/databases/${target.id}`);
        databaseMatched = true;
        const dataSources = Array.isArray(database.data_sources) ? database.data_sources : [];
        if (dataSources.length !== 1 || !dataSources[0].id) {
          throw requestError("NOTION_DATA_SOURCE_AMBIGUOUS", "Notion database must have exactly one data source");
        }
        const dataSource = await request(`/data_sources/${dataSources[0].id}`);
        return { id: dataSources[0].id, dataSource };
      } catch (error) {
        if (target.type === "database" || target.database_id_present || databaseMatched || error.code === "NOTION_DATA_SOURCE_AMBIGUOUS") throw error;
      }
    }
    const dataSource = await request(`/data_sources/${target.id}`);
    return { id: target.id, dataSource };
  };

  const buildSearchBody = (rawRequest, pageSize) => {
    const query = normalizeText(rawRequest.query, 300);
    if (!query) throw requestError("NOTION_QUERY_REQUIRED", "Notion search query required");
    const body = { query, page_size: pageSize };
    const filter = rawRequest.filter && typeof rawRequest.filter === "object" && !Array.isArray(rawRequest.filter) ? rawRequest.filter : null;
    if (filter && filter.property === "object") {
      const filterValue = filter.value === "database" ? "data_source" : filter.value;
      if (filterValue === "page" || filterValue === "data_source") {
        body.filter = { property: "object", value: filterValue };
      }
    }
    const rawSort = rawRequest.sort && typeof rawRequest.sort === "object" && !Array.isArray(rawRequest.sort)
      ? rawRequest.sort
      : Array.isArray(rawRequest.sorts) && rawRequest.sorts[0] && typeof rawRequest.sorts[0] === "object"
        ? rawRequest.sorts[0]
        : null;
    if (rawSort && rawSort.timestamp === "last_edited_time" && (rawSort.direction === "ascending" || rawSort.direction === "descending")) {
      body.sort = { timestamp: "last_edited_time", direction: rawSort.direction };
    }
    return body;
  };

  const buildDataSourceQueryBody = (rawRequest, pageSize) => {
    const body = { page_size: pageSize };
    if (rawRequest.filter && typeof rawRequest.filter === "object" && !Array.isArray(rawRequest.filter)) {
      body.filter = rawRequest.filter;
    }
    if (Array.isArray(rawRequest.sorts) && rawRequest.sorts.length > 0) {
      body.sorts = rawRequest.sorts.slice(0, 3);
    }
    return body;
  };

  const runRead = async (rawRequest = {}) => {
    const operation = String(rawRequest.operation || "").trim();
    if (!READ_OPERATIONS.has(operation) || isBlockedOperation(operation)) {
      return { ok: false, operation, reason: "notion_read_operation_denied" };
    }
    const target = normalizeTarget(rawRequest.target);
    const pageSize = Math.max(1, Math.min(Number(rawRequest.page_size) || maxResults, maxResults));
    try {
      if (operation === "search") {
        return {
          ok: true,
          operation,
          result: sanitizeResult(await request("/search", {
            method: "POST",
            body: buildSearchBody(rawRequest, pageSize),
          }), maxResultChars),
        };
      }
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
        const dataSource = await resolveSingleDataSource(target);
        return {
          ok: true,
          operation,
          target_id_hash: hashIdentifier(dataSource.id),
          result: sanitizeResult(await request(`/data_sources/${dataSource.id}/query`, {
            method: "POST",
            body: buildDataSourceQueryBody(rawRequest, pageSize),
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
        const dataSource = target.type === "data_source" || target.type === "database" || target.database_id_present || target.data_source_id_present || (target.url_present && target.type !== "page" && target.type !== "block")
          ? await resolveSingleDataSource(target).catch((error) => {
            if (
              target.url_present &&
              target.type !== "data_source" &&
              target.type !== "database" &&
              !target.database_id_present &&
              !target.data_source_id_present &&
              error &&
              error.code === "NOTION_REQUEST_FAILED" &&
              error.status === 404
            ) {
              return null;
            }
            throw error;
          })
          : null;
        const parentType = dataSource ? "data_source_id" : "page_id";
        const parentId = dataSource ? dataSource.id : target.id;
        const titlePropertyName = dataSource ? findTitlePropertyName(dataSource.dataSource) : "title";
        const children = buildChildren(rawRequest);
        const result = await request("/pages", {
          method: "POST",
          body: {
            parent: { [parentType]: parentId },
            properties: {
              [titlePropertyName]: {
                title: titleToRichText(rawRequest.title),
              },
            },
            children,
          },
        });
        return { ok: true, operation, target_id_hash: hashIdentifier(parentId), page_id: result.id, url: result.url };
      }
      if (operation === "append_blocks") {
        const blocks = buildChildren(rawRequest);
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
