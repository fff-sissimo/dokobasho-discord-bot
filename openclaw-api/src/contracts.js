"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const POSTABLE_ACTIONS = new Set(["reply", "offer", "assist"]);
const NON_POSTING_ACTIONS = new Set(["observe", "draft", "publish_blocked"]);
const VALID_ACTIONS = new Set([...POSTABLE_ACTIONS, ...NON_POSTING_ACTIONS]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const VALID_FOLLOWUP_KINDS = new Set([
  "explicit_request",
  "agreed_todo",
  "formal_quest",
  "creation_continuation",
  "test_only",
]);
const VALID_FOLLOWUP_BASIS = new Set([
  "explicit_user_request",
  "agreed_in_thread",
  "due_followup",
  "unknown",
]);

const normalizeString = (value) => String(value || "").replace(/\s+/g, " ").trim();
const hasOwn = (source, key) => Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
const pickOwn = (primary, key, fallback) => (hasOwn(primary, key) ? primary[key] : fallback && fallback[key]);
const normalizeSafeIdentifier = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 80) return "";
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) return "";
  if (/https?:\/\//i.test(text)) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd|key)\s*[:=]/i.test(text)) return "";
  if (/(?:bearer|basic)[_.:-]?[a-z0-9._~+/=-]{8,}/i.test(text)) return "";
  return text;
};

const buildObserveResponse = (reason) => ({
  schema_version: 1,
  action: "observe",
  body: "",
  reason: normalizeString(reason),
  confidence: "low",
  memory_candidates: [],
  followup_candidates: [],
  checked_followup_ids: [],
  closed_followup_ids: [],
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

const normalizeFollowupMetadata = (candidate) => {
  const source = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
  const kind = String(pickOwn(metadata, "kind", source) || "").trim();
  const basis = String(pickOwn(metadata, "basis", source) || "").trim();
  return {
    kind: VALID_FOLLOWUP_KINDS.has(kind) ? kind : "",
    basis: VALID_FOLLOWUP_BASIS.has(basis) ? basis : "unknown",
    assignee_member_id: normalizeSafeIdentifier(pickOwn(metadata, "assignee_member_id", source)),
    source_followup_id: normalizeSafeIdentifier(pickOwn(metadata, "source_followup_id", source)),
  };
};

const normalizeFollowupCandidate = (candidate) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      summary: "",
      due_at: "",
      notes: "",
      metadata: normalizeFollowupMetadata({}),
    };
  }
  const metadata = normalizeFollowupMetadata(candidate);
  return {
    summary: normalizeString(candidate.summary),
    due_at: String(candidate.due_at || "").trim(),
    notes: normalizeString(candidate.notes),
    kind: metadata.kind,
    basis: metadata.basis,
    assignee_member_id: metadata.assignee_member_id,
    source_followup_id: metadata.source_followup_id,
    metadata,
  };
};

const normalizeFollowupCandidates = (value) =>
  normalizeArray(value).map(normalizeFollowupCandidate);

const normalizeApproval = (approval) => {
  const source = approval && typeof approval === "object" && !Array.isArray(approval) ? approval : {};
  return {
    target_channel_id: String(source.target_channel_id || "").trim(),
    body: normalizeString(source.body),
    mentions: [],
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
    followup_candidates: normalizeFollowupCandidates(value.followup_candidates),
    checked_followup_ids: normalizeArray(value.checked_followup_ids),
    closed_followup_ids: normalizeArray(value.closed_followup_ids),
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
  "返却 JSON は schema_version, action, body, reason, confidence, memory_candidates, followup_candidates, checked_followup_ids, closed_followup_ids, requires_approval, approval を含めてください。",
  "action は observe, reply, offer, assist, draft, publish_blocked のどれかだけです。",
  "everyone/here、role mention、外部 URL、添付、公開告知、運営判断、承認が必要な内容は requires_approval を true にするか publish_blocked にしてください。",
  "approval.mentions は常に空配列にしてください。許可された mention はありません。",
  "外部 URL が含まれていても、URL 本文やリンク先内容を自動取得・要約・記憶しないでください。ユーザーが貼った URL は文字列として扱い、本文取得が必要なら確認してください。",
  "raw Discord 本文、秘密値、未加工の会話ログは保存・出力しないでください。memory_candidates には要約済みで長く効く事実だけを入れてください。",
  "followup_candidates は既存互換の summary, due_at, notes に加え、metadata.kind, metadata.basis, metadata.assignee_member_id, metadata.source_followup_id を含めてください。",
  "followup_candidates[].metadata.kind は explicit_request, agreed_todo, formal_quest, creation_continuation, test_only のどれかです。test_only はテスト fixture 以外では使わないでください。",
  "followup_candidates[].metadata.basis は explicit_user_request, agreed_in_thread, due_followup, unknown のどれかです。assignee_member_id と source_followup_id は分かる場合だけ ID 文字列を入れてください。",
  "due followup を一度確認したら checked_followup_ids、完了・不要・取り下げなら closed_followup_ids に ID だけを入れ、raw 本文は入れないでください。",
  "channel.type が chat の場合、場が自然に流れている通常会話は observe を既定にし、明示 mention、bot への reply、または直接聞かれた時だけ短く返してください。",
  "chat で active_thread_age_minutes が 30 を超える場合は、明示 mention、reply、約束済み followup がない限り前の会話を勝手に再開しないでください。",
  "",
  "# Channel policy",
  "- board: current request only です。proactive な再開・追いかけ・後日の持ち出しはしないでください。未採用アイデア、雑な案、検討中の断片を stable memory にしないでください。project として継続扱いにする前に、必ず project 昇格の確認を挟んでください。",
  "- project: active thread は 24h です。active_thread_age_minutes が 1440 以下なら続きとして扱えます。proactive window は 6h で、active_thread_age_minutes が 360 以下かつ約束済み followup がある場合だけ offer/assist を検討できます。24h を超えたら、続き扱いにする前に確認してください。",
  "- creation: 本人が求めた相談・壁打ち・制作支援だけに応答してください。active thread 内でも、依頼や明示的な続行合図なしに自発会話を始めることは基本しないでください。",
  "- ops: 原則として送信しないでください。公開告知、運営判断、チャンネル方針、外部向け文面は draft、publish_blocked、または requires_approval: true にしてください。",
  "",
  "# Runtime files",
  workspaceContext || "(no workspace context loaded)",
  "",
  "# Discord payload",
  "```json",
  JSON.stringify(payload, null, 2),
  "```",
].join("\n");

const collectJsonObjectTexts = (text) => {
  const source = String(text || "").trim();
  const candidates = [];
  if (source.startsWith("{") && source.endsWith("}")) candidates.push(source);
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return [...new Set(candidates.filter(Boolean))];
};

const parseJsonObject = (text, { preferLast = false } = {}) => {
  const candidates = collectJsonObjectTexts(text);
  const ordered = preferLast ? [...candidates].reverse() : candidates;
  for (const candidate of ordered) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
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
  const parsedStdout = parseJsonObject(stdout);
  if (!parsedStdout) return buildObserveResponse("unparseable_openclaw_output");
  const agentText = extractAgentText(parsedStdout);
  if (!agentText) return normalizeOpenClawResponse(parsedStdout);
  const parsedAgentText = parseJsonObject(agentText, { preferLast: true });
  if (parsedAgentText) return normalizeOpenClawResponse(parsedAgentText);
  return normalizeOpenClawResponse(parsedStdout);
};

module.exports = {
  buildAgentPrompt,
  buildObserveResponse,
  loadWorkspaceContext,
  normalizeOpenClawResponse,
  parseAgentResponse,
};
