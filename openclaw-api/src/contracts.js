"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const POSTABLE_ACTIONS = new Set(["reply", "offer", "assist"]);
const NON_POSTING_ACTIONS = new Set(["observe", "draft", "publish_blocked"]);
const VALID_ACTIONS = new Set([...POSTABLE_ACTIONS, ...NON_POSTING_ACTIONS]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const ACTION_ALIASES = new Map([
  ["ignore", "observe"],
  ["silent", "observe"],
  ["none", "observe"],
  ["noop", "observe"],
  ["no_op", "observe"],
  ["no-op", "observe"],
  ["draft_only", "draft"],
  ["draft_reply", "draft"],
  ["approval_required", "publish_blocked"],
  ["needs_approval", "publish_blocked"],
  ["blocked", "publish_blocked"],
  ["block", "publish_blocked"],
  ["publish-blocked", "publish_blocked"],
]);
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
const WORKSPACE_CONTEXT_TRUNCATED_MARKER = "\n[truncated:workspace_context_budget]";
const normalizeAction = (value) => {
  const text = normalizeString(value)
    .toLowerCase()
    .replace(/^(?:\\?["'`])+|(?:\\?["'`])+$/g, "");
  if (VALID_ACTIONS.has(text)) return text;
  return ACTION_ALIASES.get(text) || "";
};
const hasOwn = (source, key) => Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
const pickOwn = (primary, key, fallback) => (hasOwn(primary, key) ? primary[key] : fallback && fallback[key]);
const normalizeSafeIdentifier = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 80) return "";
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) return "";
  if (/https?:\/\//i.test(text)) return "";
  if (/(?:api[_-]?key|token|secret|password|passwd|key)\s*[:=]/i.test(text)) return "";
  if (/(?:bearer|basic)[_.:-]?[a-z0-9._~+/=-]{8,}/i.test(text)) return "";
  if (containsSecretLikeText(text)) return "";
  return text;
};

const DIAGNOSTIC_NUMBER_FIELDS = new Set([
  "elapsed_ms",
  "prompt_chars",
  "initial_prompt_chars",
  "retry_count",
  "retry_prompt_chars",
  "workspace_context_chars",
]);
const DIAGNOSTIC_IDENTIFIER_FIELDS = new Set(["request_id", "reason_code", "error_code"]);
const DIAGNOSTIC_FIELDS = [
  "request_id",
  "reason_code",
  "elapsed_ms",
  "prompt_chars",
  "initial_prompt_chars",
  "retry_count",
  "retry_prompt_chars",
  "workspace_context_chars",
  "error_code",
];

const normalizeDiagnosticNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.trunc(number);
};

const normalizeSafeDiagnostics = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const diagnostics = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    if (!hasOwn(source, field)) continue;
    if (DIAGNOSTIC_IDENTIFIER_FIELDS.has(field)) {
      const normalized = normalizeSafeIdentifier(source[field]);
      if (normalized) diagnostics[field] = normalized;
      continue;
    }
    if (DIAGNOSTIC_NUMBER_FIELDS.has(field)) {
      const normalized = normalizeDiagnosticNumber(source[field]);
      if (normalized !== null) diagnostics[field] = normalized;
    }
  }
  return diagnostics;
};

const buildObserveResponse = (reason, diagnostics) => {
  const response = {
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
  };
  const normalizedDiagnostics = normalizeSafeDiagnostics(diagnostics);
  if (Object.keys(normalizedDiagnostics).length > 0) {
    response.diagnostics = normalizedDiagnostics;
  }
  return response;
};

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
    summary: normalizeSafeFreeformText(candidate.summary),
    due_at: String(candidate.due_at || "").trim(),
    notes: normalizeSafeFreeformText(candidate.notes),
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
  const action = normalizeAction(value.action);
  if (!action) {
    return buildObserveResponse("invalid_openclaw_action");
  }
  if (containsSecretLikeText(value.body) || containsSecretLikeText(value.reason)) {
    return buildObserveResponse("secret_like_output");
  }
  const bodyFailureReason = classifyNonJsonErrorText(value.body);
  if (bodyFailureReason) return buildObserveResponse(bodyFailureReason);
  const reasonFailureReason = classifyNonJsonErrorText(value.reason);
  if (reasonFailureReason) return buildObserveResponse(reasonFailureReason);
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

const fitTextToBudget = (text, maxChars) => {
  const source = String(text || "");
  const budget = Number(maxChars);
  if (!Number.isFinite(budget) || budget <= 0 || source.length <= budget) return source;
  if (budget <= WORKSPACE_CONTEXT_TRUNCATED_MARKER.length) return source.slice(0, budget);
  return `${source.slice(0, budget - WORKSPACE_CONTEXT_TRUNCATED_MARKER.length)}${WORKSPACE_CONTEXT_TRUNCATED_MARKER}`;
};

const appendSectionWithinBudget = (output, section, maxChars) => {
  const budget = Number(maxChars);
  const separator = output ? "\n\n---\n\n" : "";
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      output: `${output}${separator}${section}`,
      truncated: false,
    };
  }
  const remaining = budget - output.length - separator.length;
  if (remaining <= 0) return { output, truncated: true };
  const fitted = fitTextToBudget(section, remaining);
  return {
    output: `${output}${separator}${fitted}`,
    truncated: fitted.length < section.length,
  };
};

const loadWorkspaceContext = async ({ workspaceDir, promptFiles, maxChars, required = false }) => {
  let output = "";
  let loadedFiles = 0;
  for (const filePath of promptFiles) {
    const relativePath = safeRelativePath(filePath);
    if (!relativePath) continue;
    const absolutePath = path.join(workspaceDir, relativePath);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      loadedFiles += 1;
      const next = appendSectionWithinBudget(output, `## ${relativePath}\n\n${content.trim()}`, maxChars);
      output = next.output;
      if (next.truncated) break;
    } catch (error) {
      if (required && error && error.code === "ENOENT") {
        throw error;
      }
      if (error && error.code !== "ENOENT") {
        const next = appendSectionWithinBudget(
          output,
          `## ${relativePath}\n\n[read_error:${error.code || "unknown"}]`,
          maxChars
        );
        output = next.output;
        if (next.truncated) break;
      }
    }
  }
  if (required && loadedFiles === 0) {
    const error = new Error("required workspace context was not loaded");
    error.code = "OPENCLAW_WORKSPACE_CONTEXT_MISSING";
    throw error;
  }
  return output;
};

const buildAgentPrompt = ({ payload, workspaceContext }) => [
  "あなたは Discord 上の `どこばしょのようせい` の OpenClaw 判断 API です。",
  "Discord へ直接投稿せず、必ず JSON だけを返してください。",
  "返却 JSON は schema_version, action, body, reason, confidence, memory_candidates, followup_candidates, checked_followup_ids, closed_followup_ids, requires_approval, approval を含めてください。",
  "action は observe, reply, offer, assist, draft, publish_blocked のどれかだけです。",
  "action は必ず小文字 ASCII の exact value にしてください。respond, response, message, answer などの別名は使わず、返信する時は必ず action: \"reply\" にしてください。",
  "bot への明示 mention、bot への reply、または「一言で返して」「挨拶して」のような直接依頼では、禁止要素がない限り action: \"reply\" で短く返してください。",
  "everyone/here、role mention、外部 URL、添付、公開告知、運営判断、承認が必要な内容は requires_approval を true にするか publish_blocked にしてください。",
  "approval.mentions は常に空配列にしてください。許可された mention はありません。",
  "外部 URL が含まれていても、URL 本文やリンク先内容を自動取得・要約・記憶しないでください。ユーザーが貼った URL は文字列として扱い、本文取得が必要なら確認してください。",
  "raw Discord 本文、秘密値、未加工の会話ログは保存・出力しないでください。memory_candidates には要約済みで長く効く事実だけを入れてください。",
  "followup_candidates は既存互換の summary, due_at, notes に加え、metadata.kind, metadata.basis, metadata.assignee_member_id, metadata.source_followup_id を含めてください。",
  "followup_candidates[].metadata.kind は explicit_request, agreed_todo, formal_quest, creation_continuation, test_only のどれかです。test_only はテスト fixture 以外では使わないでください。",
  "followup_candidates[].metadata.basis は explicit_user_request, agreed_in_thread, due_followup, unknown のどれかです。assignee_member_id と source_followup_id は分かる場合だけ ID 文字列を入れてください。",
  "due followup を一度確認したら checked_followup_ids、完了・不要・取り下げなら closed_followup_ids に ID だけを入れ、raw 本文は入れないでください。",
  "人格、channel policy、active thread、memory/followup の運用詳細は Runtime files を常設方針として扱ってください。",
  "channel.type、active_thread_age_minutes、mentions_bot、is_reply_to_bot、followup refs は Discord payload の構造化値を使って判断してください。",
  "",
  "# Runtime files",
  workspaceContext || "(no workspace context loaded)",
  "",
  "# Discord payload",
  "```json",
  JSON.stringify(payload),
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

const parseJsonObjects = (text, { preferLast = false } = {}) => {
  const candidates = collectJsonObjectTexts(text);
  const ordered = preferLast ? [...candidates].reverse() : candidates;
  const parsed = [];
  for (const candidate of ordered) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Try the next candidate.
    }
  }
  return parsed;
};

const extractNonJsonRemainder = (text) => {
  let remainder = String(text || "");
  const candidates = collectJsonObjectTexts(remainder).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    remainder = remainder.split(candidate).join(" ");
  }
  return normalizeString(remainder);
};

const extractAgentTexts = (result) => {
  const texts = [];
  const addText = (value) => {
    if (typeof value === "string" && value.trim()) texts.push(value);
  };
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (typeof value === "string") {
      addText(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    if (Array.isArray(value.payloads)) {
      for (const payload of [...value.payloads].reverse()) {
        if (payload && typeof payload.text === "string") {
          addText(payload.text);
        } else {
          visit(payload, depth + 1);
        }
      }
    }
    if (Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        visit(choice && choice.message && choice.message.content, depth + 1);
      }
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (item && typeof item === "object" && typeof item.text === "string") addText(item.text);
        else visit(item, depth + 1);
      }
    }
    for (const key of [
      "agent_response",
      "answer",
      "completion",
      "content",
      "data",
      "final",
      "message",
      "output",
      "reply",
      "response",
      "result",
      "text",
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        visit(value[key], depth + 1);
      }
    }
  };
  visit(result);
  return [...new Set(texts)];
};

const extractPayloadTexts = (result) => {
  const texts = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    if (Array.isArray(value.payloads)) {
      for (const payload of [...value.payloads].reverse()) {
        if (payload && typeof payload.text === "string" && payload.text.trim()) {
          texts.push(payload.text);
        }
      }
    }
    for (const key of ["agent_response", "data", "final", "output", "response", "result"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        visit(value[key], depth + 1);
      }
    }
  };
  visit(result);
  return [...new Set(texts)];
};

const isParseFailureResponse = (response) =>
  response &&
  response.action === "observe" &&
  [
    "context_overflow",
    "invalid_openclaw_response",
    "invalid_openclaw_action",
    "openclaw_error_text",
    "secret_like_output",
    "unparseable_openclaw_output",
  ].includes(response.reason);

const isClassifiedFailureResponse = (response) =>
  response &&
  response.action === "observe" &&
  ["context_overflow", "openclaw_error_text", "secret_like_output"].includes(response.reason);

const buildTextFallbackResponse = (text) => ({
  schema_version: 1,
  action: "reply",
  body: normalizeString(text).slice(0, 1800),
  reason: "non_json_openclaw_text",
  confidence: "low",
  memory_candidates: [],
  followup_candidates: [],
  checked_followup_ids: [],
  closed_followup_ids: [],
  requires_approval: false,
  approval: normalizeApproval({}),
});

const isFallbackTextCandidate = (text) => {
  const normalized = normalizeString(text);
  if (!normalized) return false;
  if (normalized.length > 1800) return false;
  if (normalized.startsWith("{") || normalized.startsWith("[")) return false;
  if (containsSecretLikeText(normalized)) return false;
  if (classifyNonJsonErrorText(normalized)) return false;
  return true;
};

function containsSecretLikeText(text) {
  const normalized = String(text || "");
  return /(?:^|[\s"'`({\[])(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(normalized) ||
    /(?:^|[\s"'`({\[])[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"',)}\]]{6,}/i.test(normalized) ||
    /(?:^|[\s"'`({\[])authorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(normalized) ||
    /(?:^|[\s"'`({\[])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(normalized) ||
    /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})(?=$|[^A-Za-z0-9_-])/i.test(normalized);
}

function normalizeSafeFreeformText(value) {
  const text = normalizeString(value);
  return text && !containsSecretLikeText(text) ? text : "";
}

const classifyNonJsonErrorText = (text) => {
  const normalized = normalizeString(text);
  if (/context overflow|prompt too large|larger-context model|try\s+\/(?:reset|new)\b|maximum context length|context length exceeded|token limit|too many tokens/i.test(normalized)) {
    return "context_overflow";
  }
  if (/\b(?:error|exception|failed|failure)\b/i.test(normalized) ||
    /\b[A-Za-z0-9_]+Error\b/.test(normalized) ||
    /request failed|rate\s*limit(?:ed)?|too many requests|(?:\bHTTP\s*|\bstatus\s*[=:]\s*)(?:429|5\d\d)\b|\b(?:429|5\d\d)\s+(?:too many requests|internal server error|service unavailable|bad gateway|gateway timeout)\b|service unavailable|bad gateway|gateway timeout/i.test(normalized)) {
    return "openclaw_error_text";
  }
  return "";
};

const WRAPPER_KEYS = [
  "agent_response",
  "answer",
  "completion",
  "content",
  "data",
  "final",
  "message",
  "output",
  "payload",
  "payloads",
  "reply",
  "response",
  "result",
  "text",
];

const collectResponseCandidates = (value, output = [], depth = 0) => {
  if (!value || depth > 5) return output;
  if (typeof value === "string") {
    for (const parsed of parseJsonObjects(value, { preferLast: true })) {
      collectResponseCandidates(parsed, output, depth + 1);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResponseCandidates(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;

  for (const text of extractAgentTexts(value)) {
    collectResponseCandidates(text, output, depth + 1);
  }
  for (const key of WRAPPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectResponseCandidates(value[key], output, depth + 1);
    }
  }
  const hasWrapperKey = WRAPPER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (Object.prototype.hasOwnProperty.call(value, "action") && !hasWrapperKey) {
    output.push(value);
  }
  return output;
};

const parseAgentResponse = (stdout) => {
  const parsedStdout = parseJsonObjects(stdout, { preferLast: true });
  if (parsedStdout.length === 0) {
    const stdoutErrorReason = classifyNonJsonErrorText(stdout);
    return buildObserveResponse(stdoutErrorReason || "unparseable_openclaw_output");
  }
  const normalized = [];
  const fallbackTexts = [];
  const errorTextReasons = [];
  const orderedPayloadResults = [];
  const nonJsonRemainder = extractNonJsonRemainder(stdout);
  if (containsSecretLikeText(nonJsonRemainder)) {
    errorTextReasons.push("secret_like_output");
  } else {
    const remainderErrorReason = classifyNonJsonErrorText(nonJsonRemainder);
    if (remainderErrorReason) errorTextReasons.push(remainderErrorReason);
  }
  for (const value of parsedStdout) {
    for (const candidate of collectResponseCandidates(value)) {
      normalized.push(normalizeOpenClawResponse(candidate));
    }
    for (const text of extractAgentTexts(value)) {
      if (containsSecretLikeText(text)) {
        errorTextReasons.push("secret_like_output");
        continue;
      }
      const errorReason = classifyNonJsonErrorText(text);
      if (errorReason) errorTextReasons.push(errorReason);
    }
    for (const text of extractPayloadTexts(value)) {
      const textResponses = collectResponseCandidates(text).map(normalizeOpenClawResponse);
      const selectedTextResponse = textResponses.find((response) =>
        isClassifiedFailureResponse(response) || !isParseFailureResponse(response)
      );
      if (selectedTextResponse) {
        orderedPayloadResults.push({ type: "response", response: selectedTextResponse });
        continue;
      }
      if (containsSecretLikeText(text)) {
        orderedPayloadResults.push({ type: "error", reason: "secret_like_output" });
        continue;
      }
      const errorReason = classifyNonJsonErrorText(text);
      if (errorReason) {
        orderedPayloadResults.push({ type: "error", reason: errorReason });
        continue;
      }
      if (isFallbackTextCandidate(text)) {
        orderedPayloadResults.push({ type: "fallback", text });
        fallbackTexts.push(text);
      }
    }
  }
  const selectedNormalized = normalized.find((response) =>
    isClassifiedFailureResponse(response) || !isParseFailureResponse(response)
  );
  if (errorTextReasons.length > 0) return buildObserveResponse(errorTextReasons[0]);
  const selectedPayload = orderedPayloadResults[0];
  if (selectedPayload && selectedPayload.type === "response") return selectedPayload.response;
  if (selectedPayload && selectedPayload.type === "error") return buildObserveResponse(selectedPayload.reason);
  if (selectedPayload && selectedPayload.type === "fallback") {
    const payloadFailure = orderedPayloadResults.find((result) =>
      result.type === "error" || (result.type === "response" && isClassifiedFailureResponse(result.response))
    );
    if (payloadFailure && payloadFailure.type === "response") return payloadFailure.response;
    if (payloadFailure && payloadFailure.type === "error") return buildObserveResponse(payloadFailure.reason);
    if (errorTextReasons.length > 0) return buildObserveResponse(errorTextReasons[0]);
    return buildTextFallbackResponse(selectedPayload.text);
  }
  return selectedNormalized ||
    (errorTextReasons.length > 0 ? buildObserveResponse(errorTextReasons[0]) : null) ||
    (fallbackTexts.length > 0 ? buildTextFallbackResponse(fallbackTexts[0]) : null) ||
    normalized[0] ||
    buildObserveResponse("invalid_openclaw_response");
};

module.exports = {
  buildAgentPrompt,
  buildObserveResponse,
  loadWorkspaceContext,
  normalizeOpenClawResponse,
  normalizeSafeDiagnostics,
  parseAgentResponse,
};
