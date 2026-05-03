"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const POSTABLE_ACTIONS = new Set(["reply", "offer", "assist"]);
const NON_POSTING_ACTIONS = new Set(["observe", "draft", "publish_blocked"]);
const VALID_ACTIONS = new Set([...POSTABLE_ACTIONS, ...NON_POSTING_ACTIONS]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

const normalizeString = (value) => String(value || "").replace(/\s+/g, " ").trim();

const buildObserveResponse = (reason) => ({
  schema_version: 1,
  action: "observe",
  body: "",
  reason: normalizeString(reason),
  confidence: "low",
  memory_candidates: [],
  followup_candidates: [],
  requires_approval: false,
  approval: {
    target_channel_id: "",
    body: "",
    mentions: [],
    attachments: [],
    links: [],
  },
});

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const normalizeApproval = (approval) => {
  const source = approval && typeof approval === "object" && !Array.isArray(approval) ? approval : {};
  return {
    target_channel_id: String(source.target_channel_id || "").trim(),
    body: normalizeString(source.body),
    mentions: normalizeArray(source.mentions),
    attachments: normalizeArray(source.attachments),
    links: normalizeArray(source.links),
  };
};

const normalizeOpenClawResponse = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return buildObserveResponse("invalid_openclaw_response");
  }
  const action = String(value.action || "").trim();
  if (!VALID_ACTIONS.has(action)) {
    return buildObserveResponse("invalid_openclaw_action");
  }
  return {
    schema_version: 1,
    action,
    body: normalizeString(value.body),
    reason: normalizeString(value.reason),
    confidence: VALID_CONFIDENCE.has(String(value.confidence || "").trim())
      ? String(value.confidence).trim()
      : "medium",
    memory_candidates: normalizeArray(value.memory_candidates),
    followup_candidates: normalizeArray(value.followup_candidates),
    requires_approval: Boolean(value.requires_approval),
    approval: normalizeApproval(value.approval),
  };
};

const safeRelativePath = (filePath) => {
  const normalized = path.normalize(String(filePath || "").trim());
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return "";
  return normalized;
};

const loadWorkspaceContext = async ({ workspaceDir, promptFiles }) => {
  const sections = [];
  for (const filePath of promptFiles) {
    const relativePath = safeRelativePath(filePath);
    if (!relativePath) continue;
    const absolutePath = path.join(workspaceDir, relativePath);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      sections.push(`## ${relativePath}\n\n${content.trim()}`);
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        sections.push(`## ${relativePath}\n\n[read_error:${error.code || "unknown"}]`);
      }
    }
  }
  return sections.join("\n\n---\n\n");
};

const buildAgentPrompt = ({ payload, workspaceContext }) => [
  "あなたは Discord 上の `どこばしょのようせい` の OpenClaw 判断 API です。",
  "Discord へ直接投稿せず、必ず JSON だけを返してください。",
  "返却 JSON は schema_version, action, body, reason, confidence, memory_candidates, followup_candidates, requires_approval, approval を含めてください。",
  "action は observe, reply, offer, assist, draft, publish_blocked のどれかだけです。",
  "everyone/here、role mention、外部 URL、添付、公開告知、運営判断、承認が必要な内容は requires_approval を true にするか publish_blocked にしてください。",
  "",
  "# Runtime files",
  workspaceContext || "(no workspace context loaded)",
  "",
  "# Discord payload",
  "```json",
  JSON.stringify(payload, null, 2),
  "```",
].join("\n");

const extractJsonObjectText = (text) => {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) return source.slice(first, last + 1);
  return source;
};

const extractAgentText = (result) => {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (VALID_ACTIONS.has(String(result.action || "").trim())) return JSON.stringify(result);
    if (Array.isArray(result.payloads)) {
      const payload = result.payloads.find((item) => item && typeof item.text === "string" && item.text.trim());
      if (payload) return payload.text;
    }
    for (const key of ["reply", "message", "content", "text", "output", "result"]) {
      if (typeof result[key] === "string") return result[key];
      if (result[key] && typeof result[key] === "object") {
        const nested = extractAgentText(result[key]);
        if (nested) return nested;
      }
    }
  }
  return typeof result === "string" ? result : "";
};

const parseAgentResponse = (stdout) => {
  try {
    const parsedStdout = JSON.parse(extractJsonObjectText(stdout));
    const agentText = extractAgentText(parsedStdout);
    if (!agentText) return normalizeOpenClawResponse(parsedStdout);
    try {
      return normalizeOpenClawResponse(JSON.parse(extractJsonObjectText(agentText)));
    } catch {
      return normalizeOpenClawResponse(parsedStdout);
    }
  } catch {
    return buildObserveResponse("unparseable_openclaw_output");
  }
};

module.exports = {
  buildAgentPrompt,
  buildObserveResponse,
  loadWorkspaceContext,
  normalizeOpenClawResponse,
  parseAgentResponse,
};
