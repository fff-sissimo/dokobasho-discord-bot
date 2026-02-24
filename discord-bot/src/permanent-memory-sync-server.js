"use strict";

const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { mkdir, appendFile, readFile } = require("node:fs/promises");

const DEFAULT_PATH = "/internal/permanent-memory/sync";
const DEFAULT_READ_PATH = "/internal/permanent-memory/read";
const DEFAULT_FILE = "permanent-memory.md";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_CHARS = 8000;

const toStringOrEmpty = (value) => (value === undefined || value === null ? "" : String(value));

const timingSafeEqualText = (left, right) => {
  const leftHash = crypto.createHash("sha256").update(toStringOrEmpty(left), "utf8").digest();
  const rightHash = crypto.createHash("sha256").update(toStringOrEmpty(right), "utf8").digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
};

const ensureIsoTimestamp = (value) => {
  const text = toStringOrEmpty(value).trim();
  if (!text) return new Date().toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error("generated_at must be a valid datetime string");
  }
  return date.toISOString();
};

const normalizeCsv = (value) =>
  toStringOrEmpty(value)
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeSyncItem = (raw, index) => {
  if (!raw || typeof raw !== "object") {
    throw new Error(`items[${index}] must be an object`);
  }

  const knowledgeId = toStringOrEmpty(raw.knowledge_id).trim();
  const statement = toStringOrEmpty(raw.statement).trim();
  if (!knowledgeId) {
    throw new Error(`items[${index}].knowledge_id is required`);
  }
  if (!statement) {
    throw new Error(`items[${index}].statement is required`);
  }

  return {
    knowledge_id: knowledgeId,
    knowledge_type: toStringOrEmpty(raw.knowledge_type).trim(),
    subject: toStringOrEmpty(raw.subject).trim(),
    statement,
    confidence: toStringOrEmpty(raw.confidence).trim(),
    tags: normalizeCsv(raw.tags),
    short_memory_ids: normalizeCsv(raw.short_memory_ids),
    source_message_links: normalizeCsv(raw.source_message_links),
    source_candidate_id: toStringOrEmpty(raw.source_candidate_id).trim(),
  };
};

const normalizeSyncPayload = (rawPayload) => {
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new Error("payload must be a JSON object");
  }

  const itemsRaw = Array.isArray(rawPayload.items) ? rawPayload.items : null;
  if (!itemsRaw || itemsRaw.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  return {
    generated_at: ensureIsoTimestamp(rawPayload.generated_at),
    source_workflow: toStringOrEmpty(rawPayload.source_workflow).trim() || "unknown",
    items: itemsRaw.map((item, index) => normalizeSyncItem(item, index)),
  };
};

const escapeMarkdownInline = (value) => toStringOrEmpty(value).replace(/\r?\n/g, " ").trim();

const buildPermanentMemoryMarkdown = (payload) => {
  const normalized = normalizeSyncPayload(payload);
  const lines = [];
  lines.push(`## ${normalized.generated_at}`);
  lines.push(`- source_workflow: ${escapeMarkdownInline(normalized.source_workflow)}`);
  lines.push(`- item_count: ${normalized.items.length}`);
  lines.push("");

  normalized.items.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${escapeMarkdownInline(item.knowledge_id)}`);
    lines.push(`- knowledge_type: ${escapeMarkdownInline(item.knowledge_type || "unknown")}`);
    lines.push(`- subject: ${escapeMarkdownInline(item.subject || "unknown")}`);
    lines.push(`- statement: ${escapeMarkdownInline(item.statement)}`);
    if (item.confidence) lines.push(`- confidence: ${escapeMarkdownInline(item.confidence)}`);
    if (item.source_candidate_id) lines.push(`- source_candidate_id: ${escapeMarkdownInline(item.source_candidate_id)}`);
    if (item.tags.length > 0) lines.push(`- tags: ${item.tags.map(escapeMarkdownInline).join(", ")}`);
    if (item.short_memory_ids.length > 0) {
      lines.push(`- short_memory_ids: ${item.short_memory_ids.map(escapeMarkdownInline).join(", ")}`);
    }
    if (item.source_message_links.length > 0) {
      lines.push(`- source_message_links: ${item.source_message_links.map(escapeMarkdownInline).join(", ")}`);
    }
    lines.push("");
  });

  return `${lines.join("\n").trim()}\n\n`;
};

const readRequestBody = (req, maxBodyBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        const error = new Error("payload too large");
        error.code = "PAYLOAD_TOO_LARGE";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      reject(error);
    });
  });

const writeJson = (res, statusCode, body) => {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

const parseRoutePath = (rawPath) => {
  const pathText = toStringOrEmpty(rawPath).trim();
  if (!pathText) return DEFAULT_PATH;
  return pathText.startsWith("/") ? pathText : `/${pathText}`;
};

const resolveTailChars = (rawTailChars, maxReadChars) => {
  const parsed = Number(rawTailChars);
  if (!Number.isFinite(parsed) || parsed <= 0) return maxReadChars;
  return Math.min(Math.floor(parsed), maxReadChars);
};

const createPermanentMemorySyncServer = ({
  token,
  outputDir,
  outputFile = DEFAULT_FILE,
  path: routePath = DEFAULT_PATH,
  readPath = DEFAULT_READ_PATH,
  host = "0.0.0.0",
  port = 8789,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxReadChars = DEFAULT_MAX_READ_CHARS,
  logger = console,
} = {}) => {
  const normalizedRoute = parseRoutePath(routePath);
  const normalizedReadRoute = parseRoutePath(readPath || DEFAULT_READ_PATH);
  const expectedToken = toStringOrEmpty(token).trim();
  const safeMaxReadChars =
    Number.isFinite(Number(maxReadChars)) && Number(maxReadChars) > 0
      ? Math.floor(Number(maxReadChars))
      : DEFAULT_MAX_READ_CHARS;
  const normalizedOutputDir = path.resolve(outputDir || path.join(process.cwd(), "permanent-memory"));
  const normalizedFileName = path.basename(toStringOrEmpty(outputFile).trim() || DEFAULT_FILE);
  const outputPath = path.join(normalizedOutputDir, normalizedFileName);

  let server = null;

  const isAuthorized = (req) => {
    if (!expectedToken) return true;
    const providedToken = toStringOrEmpty(req.headers["x-permanent-sync-token"]);
    return Boolean(providedToken) && timingSafeEqualText(providedToken, expectedToken);
  };

  const handleReadRequest = async (req, res, reqUrl) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const tailChars = resolveTailChars(reqUrl.searchParams.get("tail_chars"), safeMaxReadChars);

    let rawContent = "";
    try {
      rawContent = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        writeJson(res, 200, {
          ok: true,
          exists: false,
          output_path: outputPath,
          total_chars: 0,
          returned_chars: 0,
          tail_chars: tailChars,
          content: "",
        });
        return;
      }
      logger.error({ err: error }, "[permanent-sync] failed to read markdown");
      writeJson(res, 500, { error: "failed_to_read" });
      return;
    }

    const content = rawContent.length > tailChars ? rawContent.slice(-tailChars) : rawContent;
    writeJson(res, 200, {
      ok: true,
      exists: true,
      output_path: outputPath,
      total_chars: rawContent.length,
      returned_chars: content.length,
      tail_chars: tailChars,
      content,
    });
  };

  const handleRequest = async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (reqUrl.pathname === normalizedReadRoute) {
      await handleReadRequest(req, res, reqUrl);
      return;
    }

    if (reqUrl.pathname !== normalizedRoute) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    let bodyText = "";
    try {
      bodyText = await readRequestBody(req, maxBodyBytes);
    } catch (error) {
      if (error && error.code === "PAYLOAD_TOO_LARGE") {
        writeJson(res, 413, { error: "payload_too_large" });
        return;
      }
      logger.error({ err: error }, "[permanent-sync] failed to read request body");
      writeJson(res, 500, { error: "failed_to_read_body" });
      return;
    }

    let parsed = null;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch (_error) {
      writeJson(res, 400, { error: "invalid_json" });
      return;
    }

    let markdown = "";
    let normalizedPayload = null;
    try {
      normalizedPayload = normalizeSyncPayload(parsed);
      markdown = buildPermanentMemoryMarkdown(normalizedPayload);
    } catch (error) {
      writeJson(res, 400, {
        error: "invalid_payload",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      await mkdir(normalizedOutputDir, { recursive: true });
      await appendFile(outputPath, markdown, "utf8");
    } catch (error) {
      logger.error({ err: error }, "[permanent-sync] failed to append markdown");
      writeJson(res, 500, { error: "failed_to_persist" });
      return;
    }

    logger.info(
      {
        items: normalizedPayload.items.length,
        outputPath,
        sourceWorkflow: normalizedPayload.source_workflow,
      },
      "[permanent-sync] appended markdown"
    );

    writeJson(res, 202, {
      ok: true,
      appended_items: normalizedPayload.items.length,
      output_path: outputPath,
    });
  };

  const stop = () =>
    new Promise((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        server = null;
        resolve();
      });
    });

  return {
    start: async () => {
      if (server) {
        const addr = server.address();
        const activePort = typeof addr === "object" && addr ? addr.port : port;
        return { port: activePort, stop };
      }

      server = http.createServer((req, res) => {
        void handleRequest(req, res);
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });

      const addr = server.address();
      const activePort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(
        {
          host,
          port: activePort,
          route: normalizedRoute,
          readRoute: normalizedReadRoute,
          outputPath,
        },
        "[permanent-sync] server started"
      );

      return { port: activePort, stop };
    },
    stop,
  };
};

module.exports = {
  createPermanentMemorySyncServer,
  buildPermanentMemoryMarkdown,
  normalizeSyncPayload,
};
