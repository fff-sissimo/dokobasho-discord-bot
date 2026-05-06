"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BOT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(BOT_ROOT, "..");
const FAIRY_OPENCLAW_REPO_ROOT = path.resolve(REPO_ROOT, "..", "dokobasho-fairy-openclaw");
const CANONICAL_CHANNEL_REGISTRY_PATH = path.join(FAIRY_OPENCLAW_REPO_ROOT, "runtime", "discord-channel-registry.json");

const SECRET_ENV_NAMES = new Set([
  "BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "GOOGLE_SA_KEY_JSON",
  "N8N_WEBHOOK_URL",
  "N8N_WEBHOOK_SECRET",
  "N8N_BASE",
  "OPENAI_API_KEY",
  "NODE_AUTH_TOKEN",
  "OPENCLAW_API_KEY",
  "PERMANENT_MEMORY_SYNC_TOKEN",
  "NOTION_TOKEN",
  "NOTION_API_KEY",
]);

const REDACTION_TEXT = "[redacted]";

const parseArgs = (argv = process.argv.slice(2)) => {
  const args = { _: [] };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) {
      args[match[1]] = match[2];
      continue;
    }
    args._.push(arg);
  }
  return args;
};

const readTextIfExists = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
};

const parseDotenvLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
};

const loadEnvFile = (envFile) => {
  const env = {};
  const text = readTextIfExists(envFile);
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (parsed) env[parsed[0]] = parsed[1];
  }
  return env;
};

const buildRuntimeEnv = ({ envFile = path.join(BOT_ROOT, ".env"), baseEnv = process.env } = {}) => ({
  ...loadEnvFile(envFile),
  ...baseEnv,
});

const parseCsv = (raw) =>
  String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const parseJsonValue = (raw, label) => {
  try {
    return JSON.parse(String(raw || "{}"));
  } catch (error) {
    throw new Error(`invalid ${label} JSON`);
  }
};

const parseJsonFile = (filePath, label) => {
  const text = readTextIfExists(filePath);
  if (!text) return {};
  return parseJsonValue(text, label);
};

const normalizeCanonicalRegistry = (source) => {
  const channels = Array.isArray(source && source.channels) ? source.channels : [];
  return Object.fromEntries(
    channels
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => {
        const id = String(entry.channel_id || entry.id || "").trim();
        return [
          id,
          {
            name: String(entry.name || "").trim(),
            type: String(entry.type || "unknown").trim() || "unknown",
            status: normalizeStatus(entry.registry_status || entry.status),
            permission_worksheet_status: normalizeStatus(
              entry.permission_worksheet_status || entry.permission_status || entry.permissionStatus
            ),
            allowlist_eligibility: String(entry.allowlist_eligibility || "").trim(),
          },
        ];
      })
      .filter(([id]) => /^\d+$/.test(id))
  );
};

const loadCanonicalChannelRegistry = (registryFile = CANONICAL_CHANNEL_REGISTRY_PATH) =>
  normalizeCanonicalRegistry(parseJsonFile(registryFile, "canonical channel registry"));

const normalizeStatus = (value) => {
  const status = String(value || "").trim().toLowerCase();
  return status || "unknown";
};

const normalizeWorksheetSource = (source) => {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(
    Object.entries(source).map(([id, value]) => {
      const status =
        value && typeof value === "object" && !Array.isArray(value)
          ? value.status || value.permission_status || value.permissionStatus
          : value;
      return [String(id).trim(), normalizeStatus(status)];
    })
  );
};

const createDefaultPermissionWorksheet = (registry) =>
  Object.fromEntries(
    Object.entries(registry).map(([id, entry]) => [
      id,
      normalizeStatus(
        entry && (entry.permission_worksheet_status || entry.permission_status || entry.permissionStatus || entry.status)
      ),
    ])
  );

const loadPermissionWorksheet = ({ registry, env, args }) => {
  const worksheet = createDefaultPermissionWorksheet(registry);
  const envJson = env.FAIRY_OPENCLAW_PERMISSION_WORKSHEET_JSON;
  if (envJson) Object.assign(worksheet, normalizeWorksheetSource(parseJsonValue(envJson, "permission worksheet")));
  const worksheetFile = args["permission-worksheet"];
  if (worksheetFile) {
    Object.assign(
      worksheet,
      normalizeWorksheetSource(parseJsonFile(path.resolve(process.cwd(), worksheetFile), "permission worksheet"))
    );
  }
  return worksheet;
};

const redactText = (text) => {
  let redacted = String(text || "");
  for (const name of SECRET_ENV_NAMES) {
    const assignment = new RegExp(`\\b${name}\\s*=\\s*([^\\s'"}]+)`, "gi");
    redacted = redacted.replace(assignment, `${name}=${REDACTION_TEXT}`);
  }
  redacted = redacted.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTION_TEXT}`);
  redacted = redacted.replace(/\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*[^,\s}"']+/gi, `$1=${REDACTION_TEXT}`);
  redacted = redacted.replace(/\bcontent["']?\s*[:=]\s*["'][^"']{4,}["']/gi, `content=${REDACTION_TEXT}`);
  redacted = redacted.replace(/\braw(?:_discord|_message|_content)?["']?\s*[:=]\s*["'][^"']{4,}["']/gi, `raw=${REDACTION_TEXT}`);
  return redacted;
};

const isSafePlaceholder = (value) => {
  const normalized = String(value || "").trim();
  return !normalized ||
    normalized === REDACTION_TEXT ||
    /^redacted$/i.test(normalized) ||
    normalized.startsWith("<") ||
    /^<[^>]+>$/.test(normalized) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized);
};

const hasUnredactedSecretAssignment = (text) => {
  const source = String(text || "");
  for (const name of SECRET_ENV_NAMES) {
    const assignment = new RegExp(`\\b${name}\\s*=\\s*([^\\s'"}]+)`, "gi");
    for (const match of source.matchAll(assignment)) {
      if (!isSafePlaceholder(match[1]) && String(match[1]).length >= 8) return true;
    }
  }
  const auth = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,}|\[redacted\]|REDACTED|redacted)/gi;
  for (const match of source.matchAll(auth)) {
    if (!isSafePlaceholder(match[2]) && String(match[2]).length >= 12) return true;
  }
  const generic = /\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*([^,\s}]+|\[redacted\]|REDACTED|redacted)/gi;
  for (const match of source.matchAll(generic)) {
    if (!isSafePlaceholder(match[2]) && String(match[2]).length >= 12) return true;
  }
  return false;
};

const collectFiles = (root, predicate, results = []) => {
  if (!fs.existsSync(root)) return results;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (predicate(root)) results.push(root);
    return results;
  }
  if (!stat.isDirectory()) return results;
  for (const entry of fs.readdirSync(root)) {
    if (entry === "node_modules" || entry === "coverage" || entry === ".git") continue;
    collectFiles(path.join(root, entry), predicate, results);
  }
  return results;
};

const printRows = (rows) => {
  for (const row of rows) {
    console.log(
      [
        `channel_id=${row.channel_id}`,
        `type=${row.type}`,
        `status=${row.status}`,
        `allowlist=${row.allowlist}`,
        `gate=${row.gate}`,
      ].join(" ")
    );
  }
};

module.exports = {
  BOT_ROOT,
  CANONICAL_CHANNEL_REGISTRY_PATH,
  REPO_ROOT,
  SECRET_ENV_NAMES,
  collectFiles,
  buildRuntimeEnv,
  hasUnredactedSecretAssignment,
  loadCanonicalChannelRegistry,
  loadPermissionWorksheet,
  osTmpDir: os.tmpdir,
  parseArgs,
  parseCsv,
  parseJsonValue,
  printRows,
  redactText,
  readTextIfExists,
};
