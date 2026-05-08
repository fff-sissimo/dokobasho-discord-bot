"use strict";

const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");

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

const collectNotionIdsFromToolResult = (value, output = new Set(), depth = 0) => {
  if (depth > 6 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    const id = extractNotionId(value);
    if (id) output.add(id);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectNotionIdsFromToolResult(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value).slice(0, 80)) {
      if (/^(?:id|page_id|block_id|data_source_id|database_id|url)$/i.test(key)) {
        collectNotionIdsFromToolResult(entry, output, depth + 1);
      } else if (key === "results" || key === "data_sources" || key === "result") {
        collectNotionIdsFromToolResult(entry, output, depth + 1);
      }
    }
  }
  return output;
};

const collectSingleAllowedNotionToolResultId = (toolResults = []) => {
  const ids = new Set();
  for (const result of Array.isArray(toolResults) ? toolResults : []) {
    collectNotionIdsFromToolResult(result, ids);
  }
  return ids.size === 1 ? Array.from(ids)[0] : "";
};

const collectAllowedNotionTargetIds = (payload, toolResults = []) => {
  const notion = payload && payload.context && payload.context.notion ? payload.context.notion : {};
  const allowedIds = new Set(
    (Array.isArray(notion.links) ? notion.links : [])
      .map(extractNotionId)
      .filter(Boolean)
  );
  const toolResultId = collectSingleAllowedNotionToolResultId(toolResults);
  if (toolResultId) allowedIds.add(toolResultId);
  return allowedIds;
};

const requestTargetsAllowedPayloadTarget = ({ payload, request, toolResults = [] }) => {
  const allowedIds = collectAllowedNotionTargetIds(payload, toolResults);
  if (allowedIds.size === 0) return false;
  const target = request && request.target ? request.target : {};
  const requestId = extractNotionId(target.id || target.page_id || target.data_source_id || target.database_id || target.url);
  return Boolean(requestId && allowedIds.has(requestId));
};

const shouldCheckReadTarget = (request) => {
  const target = request && request.target ? request.target : {};
  return Boolean(target.id || target.page_id || target.data_source_id || target.database_id || target.url);
};

const normalizeToolResult = ({ result, fallbackOperation, fallbackReason }) =>
  result && typeof result === "object" && !Array.isArray(result)
    ? result
    : { ok: false, operation: fallbackOperation, reason: fallbackReason };

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
const LINK_SUMMARY_TIMEOUT_MS = 5000;
const LINK_SUMMARY_MAX_BYTES = 120000;
const LINK_SUMMARY_MAX_CHARS = 1400;
const LINK_SUMMARY_MAX_URLS = 3;
const LINK_SUMMARY_MAX_REDIRECTS = 3;

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

const normalizeExternalLinkRequest = (value, { messageLinks = [], linkCandidateUrls = [] } = {}) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (source.allowed !== true) return null;
  if (source.kind !== "explicit_external_link_summary") return null;
  const urls = (Array.isArray(source.urls) ? source.urls : [])
    .map((url) => {
      try {
        return new URL(String(url || "").trim()).href;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .slice(0, LINK_SUMMARY_MAX_URLS);
  if (urls.length === 0 || urls.length !== (Array.isArray(source.urls) ? source.urls.length : 0)) return null;
  const payloadLinks = [...(Array.isArray(messageLinks) ? messageLinks : []), ...(Array.isArray(linkCandidateUrls) ? linkCandidateUrls : [])].map((url) => {
    try {
      return new URL(String(url || "").trim()).href;
    } catch {
      return "";
    }
  }).filter(Boolean);
  const allowedLinks = new Set(payloadLinks);
  if (!urls.every((url) => allowedLinks.has(url))) return null;
  return { urls };
};

const isBlockedHostname = (hostname) => {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return !host || host === "localhost" || host.endsWith(".localhost");
};

const isBlockedIpAddress = (address) => {
  const raw = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw) return true;
  if (raw.startsWith("::ffff:")) return isBlockedIpAddress(raw.slice(7));
  const ipType = net.isIP(raw);
  if (ipType === 4) {
    const parts = raw.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
      (a === 203 && b === 0 && parts[2] === 113) ||
      a >= 224
    );
  }
  if (ipType === 6) {
    return (
      raw === "::" ||
      raw === "::1" ||
      raw.startsWith("fc") ||
      raw.startsWith("fd") ||
      raw.startsWith("fe8") ||
      raw.startsWith("fe9") ||
      raw.startsWith("fea") ||
      raw.startsWith("feb") ||
      raw.startsWith("ff") ||
      raw.startsWith("2001:db8")
    );
  }
  return true;
};

const validateExternalUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && !["80", "443"].includes(parsed.port)) return null;
  if (isBlockedHostname(parsed.hostname)) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname) && isBlockedIpAddress(hostname)) return null;
  parsed.hash = "";
  return parsed;
};

const resolvePublicAddress = async (hostname, lookupImpl = dns.lookup) => {
  const host = String(hostname || "").replace(/\.$/, "");
  if (net.isIP(host)) {
    if (isBlockedIpAddress(host)) return null;
    return { address: host, family: net.isIP(host) };
  }
  const records = await lookupImpl(host, { all: true, verbatim: true });
  const addresses = (Array.isArray(records) ? records : [records]).filter((record) => record && record.address);
  if (addresses.length === 0) return null;
  if (addresses.some((record) => isBlockedIpAddress(record.address))) return null;
  return addresses[0];
};

const stripHtmlForSummary = (value) =>
  String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const redactSummaryText = (value) =>
  String(value || "")
    .replace(/https?:\/\/\S+/gi, "[external_url]")
    .replace(/(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/gi, "[redacted_secret]")
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted_auth]")
    .replace(/(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/gi, "[token_redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[aws_key_redacted]");

const extractLinkSummary = (text) => {
  const source = String(text || "");
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = redactSummaryText(stripHtmlForSummary(titleMatch ? titleMatch[1] : "")).slice(0, 180);
  const excerpt = redactSummaryText(stripHtmlForSummary(source)).slice(0, LINK_SUMMARY_MAX_CHARS);
  return { title, excerpt };
};

const requestExternalText = async (rawUrl, {
  lookupImpl = dns.lookup,
  timeoutMs = LINK_SUMMARY_TIMEOUT_MS,
  redirectCount = 0,
} = {}) => {
  if (redirectCount > LINK_SUMMARY_MAX_REDIRECTS) return { status: "too_many_redirects" };
  const parsed = validateExternalUrl(rawUrl);
  if (!parsed) return { status: "blocked_url" };
  const resolved = await resolvePublicAddress(parsed.hostname, lookupImpl);
  if (!resolved) return { status: "blocked_url" };
  const client = parsed.protocol === "https:" ? https : http;
  const isHttps = parsed.protocol === "https:";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return new Promise((resolve) => {
    const req = client.request({
      protocol: parsed.protocol,
      hostname: resolved.address,
      family: resolved.family,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      method: "GET",
      servername: isHttps ? parsed.hostname : undefined,
      signal: controller.signal,
      headers: {
        accept: "text/html,text/plain;q=0.9,application/xhtml+xml;q=0.8,*/*;q=0.1",
        "accept-encoding": "identity",
        host: parsed.host,
        "user-agent": "dokobasho-fairy-openclaw/1.0",
      },
    }, async (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        clearTimeout(timer);
        const nextUrl = new URL(String(response.headers.location), parsed).href;
        resolve(await requestExternalText(nextUrl, { lookupImpl, timeoutMs, redirectCount: redirectCount + 1 }));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        clearTimeout(timer);
        resolve({ status: "unavailable", host: parsed.hostname });
        return;
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      const contentEncoding = String(response.headers["content-encoding"] || "").toLowerCase();
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentEncoding && contentEncoding !== "identity") {
        response.resume();
        clearTimeout(timer);
        resolve({ status: "unsupported_content_encoding", host: parsed.hostname });
        return;
      }
      if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml/.test(contentType)) {
        response.resume();
        clearTimeout(timer);
        resolve({ status: "unsupported_content_type", host: parsed.hostname });
        return;
      }
      if (contentLength > LINK_SUMMARY_MAX_BYTES) {
        response.resume();
        clearTimeout(timer);
        resolve({ status: "too_large", host: parsed.hostname });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > LINK_SUMMARY_MAX_BYTES) {
          response.destroy(new Error("link summary response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve({ status: "ok", host: parsed.hostname, text: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", () => {
        clearTimeout(timer);
        resolve({ status: size > LINK_SUMMARY_MAX_BYTES ? "too_large" : "unavailable", host: parsed.hostname });
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: error && error.name === "AbortError" ? "unavailable" : "unavailable", host: parsed.hostname });
    });
    req.end();
  });
};

const fetchExternalLinkSummaries = async (linkRequest, {
  requestTextImpl = requestExternalText,
  lookupImpl = dns.lookup,
  messageLinks = [],
  linkCandidateUrls = [],
} = {}) => {
  const normalized = normalizeExternalLinkRequest(linkRequest, { messageLinks, linkCandidateUrls });
  if (!normalized || typeof requestTextImpl !== "function") return null;
  const deadline = Date.now() + LINK_SUMMARY_TIMEOUT_MS;
  try {
    const summaries = [];
    for (const url of normalized.urls) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        summaries.push({ status: "unavailable" });
        continue;
      }
      const result = await requestTextImpl(url, { lookupImpl, timeoutMs: remainingMs });
      const host = String(result && result.host ? result.host : "").trim().toLowerCase().slice(0, 80);
      if (!result || result.status !== "ok") {
        summaries.push({ status: String((result && result.status) || "unavailable").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40), ...(host ? { host } : {}) });
        continue;
      }
      const summary = extractLinkSummary(result.text);
      summaries.push({
        status: summary.excerpt ? "ok" : "empty",
        ...(host ? { host } : {}),
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.excerpt ? { excerpt: summary.excerpt } : {}),
      });
    }
    return summaries.length > 0 ? summaries : null;
  } catch {
    return [{ status: "unavailable" }];
  }
};

const enrichAllowedLinkSummaries = async (payload, { requestTextImpl = requestExternalText, lookupImpl = dns.lookup } = {}) => {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const message = source.message && typeof source.message === "object" && !Array.isArray(source.message)
    ? source.message
    : {};
  const linkSummaries = await fetchExternalLinkSummaries(message.link_request, {
    requestTextImpl,
    lookupImpl,
    messageLinks: message.links,
    linkCandidateUrls: normalizePromptLinkCandidateUrls(source.context && source.context.link_candidates),
  });
  if (!linkSummaries) return payload;
  return {
    ...source,
    message: {
      ...message,
      link_summary: linkSummaries.length === 1 ? linkSummaries[0] : linkSummaries,
    },
  };
};

const normalizePromptChannelPolicyList = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, RETRY_IDENTIFIER_MAX_CHARS))
    .filter(Boolean)
    .slice(0, RETRY_LIST_MAX_ITEMS);

const normalizePromptChannelPolicy = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rolloutScope = String(source.rollout_scope || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, RETRY_IDENTIFIER_MAX_CHARS);
  if (!rolloutScope) return null;
  const policy = {
    rollout_scope: rolloutScope,
    allowed_work: normalizePromptChannelPolicyList(source.allowed_work),
    forbidden_work: normalizePromptChannelPolicyList(source.forbidden_work),
  };
  const instruction = String(source.instruction || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (instruction) policy.instruction = instruction;
  return policy;
};

const normalizePromptLinkSummary = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizePromptLinkSummary(item))
      .filter(Boolean)
      .slice(0, LINK_SUMMARY_MAX_URLS);
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const status = String(source.status || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
  const host = String(source.host || "").trim().toLowerCase().replace(/[^A-Za-z0-9.-]/g, "").slice(0, 80);
  if (!status) return null;
  return {
    status,
    ...(host ? { host } : {}),
    title: String(source.title || "").replace(/\s+/g, " ").trim().slice(0, 180),
    excerpt: String(source.excerpt || "").replace(/\s+/g, " ").trim().slice(0, LINK_SUMMARY_MAX_CHARS),
  };
};

const normalizePromptNotionLinks = (value) =>
  (Array.isArray(value) ? value : [])
    .map((link) => String(link || "").trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, RETRY_LIST_MAX_ITEMS);

const normalizePromptLinkCandidateUrls = (value) =>
  (Array.isArray(value) ? value : [])
    .map((candidate) => {
      const rawUrl = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate.url
        : candidate;
      try {
        return new URL(String(rawUrl || "").trim()).href;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .slice(0, LINK_SUMMARY_MAX_URLS);

const normalizePromptNotionContext = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const notion = {
    links: normalizePromptNotionLinks(source.links),
    explicit_write_requested: Boolean(source.explicit_write_requested),
    destructive_request: Boolean(source.destructive_request),
    target_provided: Boolean(source.target_provided),
  };
  if (Array.isArray(source.tool_results)) {
    notion.tool_results = source.tool_results.slice(0, 3);
  }
  return notion;
};

const PROMPT_WEB_TARGET_SECRET_KEY_PATTERN = /(?:api[_-]?key|auth(?:orization)?|auth[_-]?token|code|jwt|password|passwd|refresh[_-]?token|secret|session(?:id)?|sid|token)/i;
const PROMPT_WEB_TARGET_SECRET_VALUE_PATTERN = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)|AKIA[0-9A-Z]{16}/i;
const PROMPT_WEB_TARGET_SECRET_TEXT_PATTERN = /(?:api[_-]?key|auth|jwt|password|passwd|secret|session|token)/i;

const hasSensitivePromptWebTargetValue = (parsed) => {
  if (PROMPT_WEB_TARGET_SECRET_VALUE_PATTERN.test(parsed.pathname)) return true;
  const pathSegments = parsed.pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter(Boolean);
  if (pathSegments.some((segment) => PROMPT_WEB_TARGET_SECRET_KEY_PATTERN.test(segment))) return true;
  if (pathSegments.some((segment) => PROMPT_WEB_TARGET_SECRET_VALUE_PATTERN.test(segment))) return true;
  if (pathSegments.some((segment) => PROMPT_WEB_TARGET_SECRET_TEXT_PATTERN.test(segment))) return true;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (PROMPT_WEB_TARGET_SECRET_KEY_PATTERN.test(key)) return true;
    if (PROMPT_WEB_TARGET_SECRET_VALUE_PATTERN.test(value)) return true;
    if (PROMPT_WEB_TARGET_SECRET_TEXT_PATTERN.test(value)) return true;
  }
  return false;
};

const getPromptLinkSummaryAt = (value, index) => {
  const source = Array.isArray(value) ? value[index] : index === 0 ? value : null;
  return source && typeof source === "object" && !Array.isArray(source) ? source : null;
};

const isOkPromptLinkSummaryForTarget = (summary, parsed) => {
  if (!summary) return false;
  const status = String(summary.status || "").trim().toLowerCase();
  const host = String(summary.host || "").trim().toLowerCase();
  return status === "ok" && host === parsed.hostname.toLowerCase();
};

const normalizePromptWebTargets = (linkRequest, { messageLinks = [], linkCandidateUrls = [], linkSummary = null } = {}) => {
  const normalized = normalizeExternalLinkRequest(linkRequest, { messageLinks, linkCandidateUrls });
  if (!normalized) return [];
  return normalized.urls
    .map((url, index) => {
      const parsed = validateExternalUrl(url);
      if (!parsed) return null;
      if (hasSensitivePromptWebTargetValue(parsed)) return null;
      if (!isOkPromptLinkSummaryForTarget(getPromptLinkSummaryAt(linkSummary, index), parsed)) return null;
      return {
        url: parsed.href,
        host: parsed.hostname.toLowerCase().slice(0, 80),
      };
    })
    .filter(Boolean)
    .slice(0, LINK_SUMMARY_MAX_URLS);
};

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
    notion_links: normalizePromptNotionLinks(message.notion_links),
  };
  const projectedLinkSummary = normalizePromptLinkSummary(message.link_summary);
  if (projectedLinkSummary) projectedMessage.link_summary = projectedLinkSummary;
  const projectedWebTargets = normalizePromptWebTargets(message.link_request, {
    messageLinks: message.links,
    linkCandidateUrls: normalizePromptLinkCandidateUrls(context.link_candidates),
    linkSummary: message.link_summary,
  });
  if (projectedWebTargets.length > 0) projectedMessage.web_targets = projectedWebTargets;
  const projectedContext = {
    recent_messages: normalizePromptRecentMessages(context.recent_messages),
    active_thread_age_minutes: context.active_thread_age_minutes ?? null,
    has_promised_followup: Boolean(context.has_promised_followup),
    matched_followup_ids: normalizeRetryIdentifierList(context.matched_followup_ids),
    notion: normalizePromptNotionContext(context.notion),
  };
  if (mode === "retry" || isSelfContainedDirectRequest({ message: projectedMessage, context: projectedContext })) {
    projectedContext.recent_messages = [];
  }
  const projectedChannelPolicy = normalizePromptChannelPolicy(channel.policy);
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
      ...(projectedChannelPolicy ? { policy: projectedChannelPolicy } : {}),
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

const executeNotionRound = async ({
  payload,
  response,
  notionBridge,
  workspaceContext,
  config,
  runAgentCommand,
  logger,
  trace,
  timeoutMs,
  attemptMode,
}) => {
  if (hasDestructiveNotionRequest(payload)) {
    return buildNotionNoticeResponse(
      "notion_destructive_request_denied",
      "Notion の削除、アーカイブ、移動、複製はできません。必要なら、内容の確認や追記だけ手伝います。"
    );
  }
  if (!notionBridge || !notionBridge.enabled) return response;

  let nextResponse = response;
  let toolResults = [];
  if (Array.isArray(response.notion_requests) && response.notion_requests.length > 0) {
    for (const request of response.notion_requests.slice(0, 3)) {
      if (shouldCheckReadTarget(request) && !requestTargetsAllowedPayloadTarget({ payload, request, toolResults })) {
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
    const toolResult = await executeOpenClawPrompt({
      config,
      payload: toolPayload,
      workspaceContext,
      runAgentCommand,
      timeoutMs,
      logger,
      trace,
      attempt: "notion",
      attemptMode,
    });
    nextResponse = toolResult.response;
  }

  if (Array.isArray(nextResponse.notion_writes) && nextResponse.notion_writes.length > 0) {
    if (!shouldExecuteWrites(payload)) {
      return {
        ...buildObserveResponse("notion_write_requires_explicit_request"),
        notion_writes: nextResponse.notion_writes,
      };
    }
    if (!hasWriteTargetProvided(payload) && collectAllowedNotionTargetIds(payload, toolResults).size === 0) {
      return buildNotionNoticeResponse(
        "notion_write_target_required",
        "書き込み先の Notion ページがまだ分かりません。対象の Notion URL を送ってください。"
      );
    }
    const writeResults = [];
    for (const request of nextResponse.notion_writes.slice(0, 3)) {
      if (!requestTargetsAllowedPayloadTarget({ payload, request, toolResults })) {
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
      payload = await enrichAllowedLinkSummaries(payload);
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
      let response = result.response;
      response = await executeNotionRound({
        payload,
        response,
        notionBridge,
        workspaceContext,
        config,
        runAgentCommand,
        logger,
        trace,
        timeoutMs: remainingRequestTimeoutMs({ config, requestStartedAt }),
        attemptMode,
      });
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
  enrichAllowedLinkSummaries,
  fetchExternalLinkSummaries,
  requestExternalText,
  validateExternalUrl,
  isCompactFirstRequest,
  readJsonBody,
};
