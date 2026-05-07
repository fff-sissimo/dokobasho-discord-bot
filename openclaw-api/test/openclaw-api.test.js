"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS, loadConfig, parseBoolean } = require("../src/config");
const {
  buildOpenClawArgs,
  buildOpenClawChildEnv,
  buildOpenClawSessionStatePaths,
  buildRequestScopedSessionId,
  buildStderrDiagnostics,
  runOpenClawAgent,
} = require("../src/openclaw-runner");
const {
  buildMinimalRetryPayload,
  buildOptionalPromptFiles,
  buildPromptPayload,
  createServer,
  isCompactFirstRequest,
} = require("../src/server");
const {
  buildAgentPrompt,
  buildCompactAgentPrompt,
  buildObserveResponse,
  buildRetryAgentPrompt,
  extractMarkdownSections,
  loadWorkspaceContext,
  normalizeOpenClawResponse,
  normalizeSafeDiagnostics,
  parseAgentResponse,
} = require("../src/contracts");

const baseConfig = {
  host: "127.0.0.1",
  port: 0,
  apiKey: "secret",
  workspaceDir: "/tmp/openclaw-workspace",
  command: "openclaw",
  agentMode: "local",
  agentId: "",
  sessionId: "dokobasho-fairy-discord-v1",
  thinking: "low",
  timeoutSeconds: 60,
  requestTimeoutMs: 1000,
  firstAttemptTimeoutMs: 750,
  retryMinTimeoutMs: 150,
  killGraceMs: 10000,
  maxBodyBytes: 65536,
  maxWorkspaceContextChars: 16000,
  sessionScope: "request",
  promptFiles: ["AGENTS.md"],
};

const withServer = async (options, fn) => {
  const server = createServer({
    config: baseConfig,
    logger: { info: () => {}, warn: () => {} },
    loadContext: async () => "runtime context",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("health endpoint does not require auth", async () => {
  await withServer({ runAgentCommand: async () => "{}" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "openclaw-api");
  });
});

test("trace logging config defaults off unless env enables it", () => {
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("1"), true);
  assert.equal(parseBoolean("false"), false);
  assert.equal(loadConfig({ OPENCLAW_API_KEY: "secret" }).traceLogs, false);
  assert.equal(loadConfig({ OPENCLAW_API_KEY: "secret", OPENCLAW_TRACE_LOGS: "true" }).traceLogs, true);
});

test("discord respond requires bearer auth", async () => {
  await withServer({ runAgentCommand: async () => "{}" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "req_1" }),
    });
    assert.equal(response.status, 401);
  });
});

test("discord respond returns normalized OpenClaw response", async () => {
  await withServer({
    runAgentCommand: async ({ message }) => {
      assert.match(message, /Discord payload/);
      return JSON.stringify({
        content: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "確認しました",
          confidence: "high",
          checked_followup_ids: ["followup_1"],
          closed_followup_ids: ["followup_2"],
          requires_approval: false,
          approval: {
            mentions: ["@everyone", "<@&123>"],
          },
        }),
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_1",
        channel: { id: "1094907178671939654" },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema_version, 1);
    assert.equal(body.action, "reply");
    assert.equal(body.body, "確認しました");
    assert.equal(body.confidence, "high");
    assert.deepEqual(body.checked_followup_ids, ["followup_1"]);
    assert.deepEqual(body.closed_followup_ids, ["followup_2"]);
    assert.deepEqual(body.approval.mentions, []);
    assert.deepEqual(body.approval.links, []);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "diagnostics"), false);
  });
});

test("normalizes approval mentions to an empty array", () => {
  const response = normalizeOpenClawResponse({
    schema_version: 1,
    action: "reply",
    body: "ok",
    approval: {
      mentions: ["@everyone", "<@&123>"],
    },
  });

  assert.deepEqual(response.approval.mentions, []);
});

test("normalizes safe OpenClaw action aliases to exact contract actions", () => {
  assert.equal(normalizeOpenClawResponse({ action: "Reply", body: "ok" }).action, "reply");
  assert.equal(normalizeOpenClawResponse({ action: "\\\"reply\\\"", body: "ok" }).action, "reply");
  assert.equal(normalizeOpenClawResponse({ action: "no-op" }).action, "observe");
  assert.equal(normalizeOpenClawResponse({ action: "publish-blocked" }).action, "publish_blocked");
  assert.equal(normalizeOpenClawResponse({ action: "approval_required", body: "ok" }).action, "publish_blocked");
  assert.equal(normalizeOpenClawResponse({ action: "respond", body: "ok" }).reason, "invalid_openclaw_action");
  assert.equal(normalizeOpenClawResponse({ action: "\"message\"", body: "ok" }).reason, "invalid_openclaw_action");
});

test("normalizes response body without flattening intentional line breaks", () => {
  const response = normalizeOpenClawResponse({
    action: "reply",
    body: "  A=返信量: 短めでOK。  \n  B=安全gate: 自動返信可。  \n\n\n  C=followup: 作成なし。  ",
    approval: {
      body: "  下書き 1  \r\n  下書き 2  ",
    },
  });

  assert.equal(response.body, "A=返信量: 短めでOK。\nB=安全gate: 自動返信可。\n\nC=followup: 作成なし。");
  assert.equal(response.approval.body, "下書き 1\n下書き 2");
});

test("normalizes followup state fields as arrays", () => {
  assert.deepEqual(
    normalizeOpenClawResponse({
      schema_version: 1,
      action: "observe",
      checked_followup_ids: ["due_1"],
      closed_followup_ids: "due_2",
    }),
    {
      schema_version: 1,
      action: "observe",
      body: "",
      reason: "",
      confidence: "medium",
      memory_candidates: [],
      followup_candidates: [],
      checked_followup_ids: ["due_1"],
      closed_followup_ids: [],
      requires_approval: false,
      approval: {
        target_channel_id: "",
        body: "",
        mentions: [],
        attachments: [],
        links: [],
      },
    }
  );

  assert.deepEqual(buildObserveResponse("ok").checked_followup_ids, []);
  assert.deepEqual(buildObserveResponse("ok").closed_followup_ids, []);
});

test("normalizes followup candidate metadata while keeping summary due_at notes compatibility", () => {
  const response = normalizeOpenClawResponse({
    schema_version: 1,
    action: "observe",
    followup_candidates: [
      {
        summary: "  来週 確認する  ",
        due_at: " 2026-05-08T09:00:00+09:00 ",
        notes: "  合意 済み  ",
        kind: "agreed_todo",
        basis: "agreed_in_thread",
        assignee_member_id: " 12345 ",
        source_followup_id: " due_1 ",
      },
      {
        summary: "fixture",
        kind: "stale_top_level_kind",
        basis: "due_followup",
        metadata: {
          kind: "test_only",
          basis: "explicit_user_request",
          assignee_member_id: "67890",
          source_followup_id: "",
        },
      },
      {
        summary: "unknown values",
        assignee_member_id: "token=unsafe-secret-value",
        source_followup_id: "https://example.com/raw",
        metadata: {
          kind: "unexpected",
          basis: "unexpected",
          assignee_member_id: "",
          source_followup_id: "",
        },
      },
      {
        summary: "token metadata",
        assignee_member_id: "gho_1234567890abcdef1234567890abcdef1234",
        source_followup_id: "sk-proj-1234567890abcdef",
      },
    ],
  });

  assert.deepEqual(response.followup_candidates, [
    {
      summary: "来週 確認する",
      due_at: "2026-05-08T09:00:00+09:00",
      notes: "合意 済み",
      kind: "agreed_todo",
      basis: "agreed_in_thread",
      assignee_member_id: "12345",
      source_followup_id: "due_1",
      metadata: {
        kind: "agreed_todo",
        basis: "agreed_in_thread",
        assignee_member_id: "12345",
        source_followup_id: "due_1",
      },
    },
    {
      summary: "fixture",
      due_at: "",
      notes: "",
      kind: "test_only",
      basis: "explicit_user_request",
      assignee_member_id: "67890",
      source_followup_id: "",
      metadata: {
        kind: "test_only",
        basis: "explicit_user_request",
        assignee_member_id: "67890",
        source_followup_id: "",
      },
    },
    {
      summary: "unknown values",
      due_at: "",
      notes: "",
      kind: "",
      basis: "unknown",
      assignee_member_id: "",
      source_followup_id: "",
      metadata: {
        kind: "",
        basis: "unknown",
        assignee_member_id: "",
        source_followup_id: "",
      },
    },
    {
      summary: "token metadata",
      due_at: "",
      notes: "",
      kind: "",
      basis: "unknown",
      assignee_member_id: "",
      source_followup_id: "",
      metadata: {
        kind: "",
        basis: "unknown",
        assignee_member_id: "",
        source_followup_id: "",
      },
    },
  ]);
});

test("invalid OpenClaw output becomes observe response", () => {
  const response = parseAgentResponse("not json");
  assert.equal(response.action, "observe");
  assert.equal(response.reason, "unparseable_openclaw_output");
});

test("stderr diagnostics redact unsafe text while preserving a stable hash", () => {
  const diagnostics = buildStderrDiagnostics([
    "OpenClaw warning",
    "Request failed at https://example.com/raw?token=secret",
    "Authorization: Bearer abcdefghijklmnop",
    "api_key=sk-proj-abcdef1234567890",
  ].join("\n"));

  assert.equal(diagnostics.stderr_line_count, 4);
  assert.match(diagnostics.stderr_tail_hash, /^[0-9a-f]{16}$/);
  assert.match(diagnostics.stderr_tail_safe, /\[url\]/);
  assert.match(diagnostics.stderr_tail_safe, /\[auth_redacted\]/);
  assert.match(diagnostics.stderr_tail_safe, /api_key=\[redacted\]/);
  assert.doesNotMatch(diagnostics.stderr_tail_safe, /example\.com/);
  assert.doesNotMatch(diagnostics.stderr_tail_safe, /abcdefghijklmnop/);
  assert.doesNotMatch(diagnostics.stderr_tail_safe, /sk-proj-/);
});

test("normalizes diagnostics to whitelisted structured fields only", () => {
  assert.deepEqual(normalizeSafeDiagnostics({
    request_id: "req_1",
    reason_code: "context_overflow",
    attempt_mode: "full_first",
    elapsed_ms: 12.9,
    first_attempt_timeout_ms: 75000,
    prompt_chars: "120",
    initial_prompt_chars: 140,
    retry_count: 1,
    retry_prompt_chars: 80,
    retry_stderr_line_count: 2,
    retry_stderr_tail_hash: "abcdef1234567890",
    workspace_context_chars: 40,
    stderr_line_count: 3,
    stderr_tail_hash: "0123456789abcdef",
    error_code: "OPENCLAW_TIMEOUT",
    stdout: "raw stdout",
    prompt: "raw prompt",
    stack: "Error stack",
    message: "freeform error",
    url: "https://example.com/raw",
  }), {
    request_id: "req_1",
    reason_code: "context_overflow",
    attempt_mode: "full_first",
    elapsed_ms: 12,
    first_attempt_timeout_ms: 75000,
    prompt_chars: 120,
    initial_prompt_chars: 140,
    retry_count: 1,
    retry_prompt_chars: 80,
    retry_stderr_line_count: 2,
    retry_stderr_tail_hash: "abcdef1234567890",
    workspace_context_chars: 40,
    stderr_line_count: 3,
    stderr_tail_hash: "0123456789abcdef",
    error_code: "OPENCLAW_TIMEOUT",
  });

  assert.deepEqual(normalizeSafeDiagnostics({
    request_id: "https://example.com/raw",
    reason_code: "token=unsafe-secret-value",
    error_code: "boom message with spaces",
    elapsed_ms: -1,
  }), {});
});

test("agent prompt includes phase2 chat restraint rules", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: "runtime context\nchat は active thread 30分。30分を超えたら勝手に再開しない。",
    payload: {
      channel: { id: "840827137451229210", type: "chat" },
      context: { active_thread_age_minutes: 31 },
    },
  });

  assert.match(prompt, /channel\.type/);
  assert.match(prompt, /active_thread_age_minutes/);
  assert.match(prompt, /Runtime files を常設方針/);
  assert.match(prompt, /checked_followup_ids/);
  assert.match(prompt, /closed_followup_ids/);
  assert.match(prompt, /metadata\.kind/);
  assert.match(prompt, /explicit_request, agreed_todo, formal_quest, creation_continuation, test_only/);
  assert.match(prompt, /metadata\.basis/);
  assert.match(prompt, /explicit_user_request, agreed_in_thread, due_followup, unknown/);
  assert.match(prompt, /due followup を一度確認したら/);
  assert.match(prompt, /ID だけを入れ、raw 本文は入れない/);
  assert.match(prompt, /一人称は `僕`/);
  assert.match(prompt, /短い挨拶.*説明ではなく短い挨拶そのもの/);
  assert.match(prompt, /改行箇条書き/);
});

test("agent prompt keeps Discord payload compact", () => {
  const payload = {
    channel: { id: "1094907178671939654", type: "sandbox" },
    message: { id: "msg_1", content: "短い確認" },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: "前の文脈", created_at: "2026-05-03T09:45:00.000Z" },
      ],
    },
  };
  const prompt = buildAgentPrompt({ workspaceContext: "runtime context", payload });

  assert.match(prompt, /# Discord payload\n```json\n\{"channel":/);
  assert.doesNotMatch(prompt, /\n  "channel"/);
  assert.ok(prompt.length < buildAgentPrompt({ workspaceContext: "runtime context", payload: {} }).length + 500);
});

test("agent prompt stays under the OpenClaw live-smoke budget for capped context", () => {
  const payload = {
    request_id: "synthetic",
    schema_version: 1,
    source: "discord",
    event_type: "message_create",
    received_at: "2026-05-06T06:30:00.000Z",
    guild_id: "840827137451229205",
    channel: {
      id: "1094907178671939654",
      name: "妖精さんより",
      type: "sandbox",
      registered: true,
      thread_id: "",
      parent_channel_id: "",
      category_id: "",
    },
    message: {
      id: "msg_live_smoke",
      author_id: "user_1",
      author_display_name: "user",
      content: "live smoke S-1: 短い挨拶です。今の調子を一言で返してください。",
      created_at: "2026-05-06T06:30:00.000Z",
      is_reply_to_bot: false,
      mentions_bot: true,
      mentions_everyone: false,
      role_mentions: [],
      attachments: [],
      links: [],
    },
    context: {
      recent_messages: Array.from({ length: 5 }, (_, index) => ({
        message_id: `ctx_${index}`,
        author_id: "user_1",
        content: `${index}: ${"x".repeat(300)}`,
        created_at: "2026-05-06T06:29:00.000Z",
      })),
      active_thread_age_minutes: 1,
      has_promised_followup: false,
      matched_followup_ids: [],
    },
    memory: {
      member_ids: [],
      project_ids: [],
      daily_refs: [],
    },
  };
  const prompt = buildAgentPrompt({
    workspaceContext: "x".repeat(DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS),
    payload,
  });

  assert.ok(prompt.length < 9000);
});

test("agent prompt includes channel active thread and output policies", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: [
      "runtime context",
      "board は current request only。未採用アイデアを stable memory にしない。",
      "project は active thread 24h。proactive は6h以内かつ約束済み followup がある場合だけ。",
      "creation は本人が求めた相談だけに応答する。",
      "ops、公開告知、運営判断、外部向け文面は自動投稿しない。",
    ].join("\n"),
    payload: {
      channel: { id: "840827137451229210", type: "board" },
      context: { active_thread_age_minutes: 31 },
    },
  });

  assert.match(prompt, /board は current request only/);
  assert.match(prompt, /未採用アイデア.*stable memory/);
  assert.match(prompt, /project は active thread 24h/);
  assert.match(prompt, /proactive は6h/);
  assert.match(prompt, /creation は本人が求めた相談/);
  assert.match(prompt, /ops、公開告知、運営判断/);
  assert.match(prompt, /自動投稿しない/);
});

test("agent prompt keeps URL, mention, and raw Discord body safety rules", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: "runtime context",
    payload: {
      channel: { id: "840827137451229210", type: "board" },
      content: "https://example.com",
    },
  });

  assert.match(prompt, /approval\.mentions は常に空配列/);
  assert.match(prompt, /許可された mention はありません/);
  assert.match(prompt, /URL 本文やリンク先内容を自動取得・要約・記憶しない/);
  assert.match(prompt, /raw Discord 本文、秘密値、未加工の会話ログは保存・出力しない/);
  assert.match(prompt, /respond, response, message, answer などの別名は使わず/);
  assert.match(prompt, /bot への明示 mention/);
  assert.match(prompt, /action: "reply"/);
});

test("agent prompt keeps draft-only boundaries for approval-gated operations", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: "runtime context",
    payload: {
      channel: { id: "840827137451229210", type: "ops" },
      content: "公開告知を出して",
    },
  });

  assert.match(prompt, /Discord へ直接投稿せず、必ず JSON だけを返してください/);
  assert.match(prompt, /公開告知、運営判断、承認が必要な内容/);
  assert.match(prompt, /requires_approval を true にするか publish_blocked/);
  assert.match(prompt, /approval\.mentions は常に空配列/);
});

test("retry agent prompt stays short and excludes runtime context sections", () => {
  const payload = buildMinimalRetryPayload({
    request_id: "req_retry_prompt",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "live smoke S-1: 短い挨拶です。今の調子を一言で返してください。",
      mentions_bot: true,
    },
    context: { recent_messages: [] },
  });
  const normalPrompt = buildAgentPrompt({
    workspaceContext: "runtime context".repeat(100),
    payload,
  });
  const retryPrompt = buildRetryAgentPrompt({ payload });

  assert.ok(retryPrompt.length < normalPrompt.length);
  assert.match(retryPrompt, /context overflow/);
  assert.match(retryPrompt, /一人称は `僕`/);
  assert.match(retryPrompt, /説明ではなく短い挨拶そのもの/);
  assert.match(retryPrompt, /改行箇条書き/);
  assert.match(retryPrompt, /# Discord payload/);
  assert.doesNotMatch(retryPrompt, /# Runtime files/);
  assert.doesNotMatch(retryPrompt, /runtime context/);
  assert.doesNotMatch(retryPrompt, /\(no workspace context loaded\)/);
});

test("compact agent prompt stays short and keeps direct-response safety rules", () => {
  const payload = buildMinimalRetryPayload({
    request_id: "req_compact_prompt",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "ping 一言で返してください",
      mentions_bot: true,
    },
    context: { recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "old" }] },
  });
  const compactPrompt = buildCompactAgentPrompt({ payload });

  assert.match(compactPrompt, /必ず JSON だけ/);
  assert.match(compactPrompt, /approval\.mentions は常に空配列/);
  assert.match(compactPrompt, /一人称は `僕`/);
  assert.match(compactPrompt, /説明ではなく短い挨拶そのもの/);
  assert.match(compactPrompt, /改行箇条書き/);
  assert.match(compactPrompt, /外部 URL は自動取得しない/);
  assert.match(compactPrompt, /raw Discord 本文、秘密値/);
  assert.match(compactPrompt, /# Discord payload/);
  assert.doesNotMatch(compactPrompt, /# Runtime files/);
  assert.doesNotMatch(compactPrompt, /"recent_messages":\[\{/);
  assert.ok(compactPrompt.length < 1800);
});

test("workspace context is capped by configured prompt budget", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-"));
  try {
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "A".repeat(200), "utf8");
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), "B".repeat(200), "utf8");

    const context = await loadWorkspaceContext({
      workspaceDir,
      promptFiles: ["AGENTS.md", "TOOLS.md"],
      maxChars: 120,
    });

    assert.ok(context.length <= 120);
    assert.match(context, /AGENTS\.md/);
    assert.match(context, /truncated:workspace_context_budget/);
    assert.doesNotMatch(context, /TOOLS\.md/);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace context can load curated prompt files and optional excerpts within budget", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-files-"));
  try {
    await fs.writeFile(path.join(workspaceDir, "RUNTIME_PROMPT.md"), "runtime", "utf8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "identity", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "soul", "utf8");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "memory", "utf8");
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), [
      "# TOOLS",
      "## ops",
      "ops excerpt",
      "## unrelated",
      "x".repeat(500),
      "### Publish boundaries",
      "publish excerpt",
    ].join("\n"), "utf8");

    const context = await loadWorkspaceContext({
      workspaceDir,
      promptFiles: [
        "RUNTIME_PROMPT.md",
        "IDENTITY.md",
        "SOUL.md",
        "MEMORY.md",
        {
          path: "TOOLS.md",
          label: "TOOLS.md ops excerpt",
          optional: true,
          headings: ["ops", "Publish boundaries"],
          maxChars: 120,
        },
        {
          path: "MISSING_OPTIONAL.md",
          label: "missing optional",
          optional: true,
        },
      ],
      maxChars: 4000,
      required: true,
    });

    assert.match(context, /## RUNTIME_PROMPT\.md/);
    assert.match(context, /## IDENTITY\.md/);
    assert.match(context, /## SOUL\.md/);
    assert.match(context, /## MEMORY\.md/);
    assert.match(context, /## TOOLS\.md ops excerpt/);
    assert.match(context, /ops excerpt/);
    assert.match(context, /publish excerpt/);
    assert.doesNotMatch(context, /MISSING_OPTIONAL/);
    assert.doesNotMatch(context, /x{100}/);
    assert.ok(context.length <= 4000);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace context keeps both optional excerpts meaningful with production-sized base files", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-sized-"));
  try {
    await fs.writeFile(path.join(workspaceDir, "RUNTIME_PROMPT.md"), "R".repeat(1159), "utf8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "I".repeat(471), "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "S".repeat(729), "utf8");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "M".repeat(396), "utf8");
    await fs.writeFile(path.join(workspaceDir, "OPEN_ITEMS.md"), [
      "# OPEN_ITEMS",
      "### publish 予約と followup の扱いが矛盾している",
      "followup open item body",
      "### followup の `checked` が終端か再確認待ちか曖昧",
      "checked open item body",
      "### followup の時刻形式とタイムゾーンが未定義",
      "timezone open item body",
      "### sandbox followup の扱いが未定義",
      "sandbox open item body",
      "### unrelated",
      "x".repeat(1000),
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), [
      "# TOOLS",
      "## ops",
      "ops boundary body",
      "### Publish boundaries",
      "publish boundary body",
      "## unrelated",
      "y".repeat(1000),
    ].join("\n"), "utf8");

    const context = await loadWorkspaceContext({
      workspaceDir,
      promptFiles: [
        "RUNTIME_PROMPT.md",
        "IDENTITY.md",
        "SOUL.md",
        "MEMORY.md",
        ...buildOptionalPromptFiles({
          channel: { type: "ops" },
          context: { matched_followup_ids: ["due_1"] },
        }),
      ],
      maxChars: 4000,
      required: true,
    });

    assert.ok(context.length <= 4000);
    assert.match(context, /## OPEN_ITEMS\.md followup open items excerpt/);
    assert.match(context, /followup open item body/);
    assert.match(context, /checked open item body/);
    assert.match(context, /timezone open item body/);
    assert.match(context, /sandbox open item body/);
    assert.match(context, /## TOOLS\.md ops publish boundaries excerpt/);
    assert.match(context, /ops boundary body/);
    assert.match(context, /publish boundary body/);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("extractMarkdownSections returns only requested heading subtrees", () => {
  const extracted = extractMarkdownSections([
    "# Root",
    "intro",
    "## ops",
    "ops body",
    "### nested",
    "nested body",
    "## chat",
    "chat body",
    "## Publish boundaries",
    "publish body",
  ].join("\n"), ["ops", "Publish boundaries"]);

  assert.match(extracted, /## ops/);
  assert.match(extracted, /nested body/);
  assert.match(extracted, /## Publish boundaries/);
  assert.doesNotMatch(extracted, /chat body/);
});

test("parses OpenClaw CLI payload text output", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "observe",
          body: "",
          reason: "ok",
        }),
      },
    ],
  }));
  assert.equal(response.action, "observe");
  assert.equal(response.reason, "ok");
});

test("parses OpenClaw CLI payload when text contains fenced prompt examples", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: [
          "runtime context includes an example",
          "```json",
          JSON.stringify({
            schema_version: 1,
            source: "discord",
            event_type: "message_create|message_update|followup_tick|manual_check",
          }, null, 2),
          "```",
          JSON.stringify({
            schema_version: 1,
            action: "reply",
            body: "疎通できています",
            reason: "ok",
            confidence: "high",
          }),
        ].join("\n"),
      },
    ],
  }));
  assert.equal(response.action, "reply");
  assert.equal(response.body, "疎通できています");
  assert.equal(response.confidence, "high");
});

test("parses final OpenClaw response after earlier status events", () => {
  const response = parseAgentResponse([
    JSON.stringify({ type: "status", message: "thinking" }),
    JSON.stringify({
      payloads: [
        {
          text: JSON.stringify({
            schema_version: 1,
            action: "reply",
            body: "短く返します",
            confidence: "high",
          }),
        },
      ],
    }),
  ].join("\n"));

  assert.equal(response.action, "reply");
  assert.equal(response.body, "短く返します");
});

test("prefers the final valid OpenClaw response over earlier valid event JSON", () => {
  const response = parseAgentResponse([
    JSON.stringify({
      schema_version: 1,
      action: "observe",
      body: "",
      reason: "status_event",
    }),
    JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "final response",
      confidence: "high",
    }),
  ].join("\n"));

  assert.equal(response.action, "reply");
  assert.equal(response.body, "final response");
});

test("does not let wrapper action aliases override an inner non-posting response", () => {
  const response = parseAgentResponse(JSON.stringify({
    action: "message",
    body: "outer wrapper text",
    response: {
      schema_version: 1,
      action: "publish_blocked",
      body: "",
      reason: "approval required",
      requires_approval: true,
    },
  }));

  assert.equal(response.action, "publish_blocked");
  assert.equal(response.reason, "approval required");
  assert.equal(response.requires_approval, true);
});

test("does not adopt outer wrapper action when the inner response is invalid", () => {
  const response = parseAgentResponse(JSON.stringify({
    action: "reply",
    body: "outer wrapper text",
    response: {
      body: "inner text without action",
    },
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "invalid_openclaw_response");
  assert.equal(response.body, "");
});

test("parses wrapped OpenClaw response objects", () => {
  const nestedResponse = parseAgentResponse(JSON.stringify({
    response: {
      schema_version: 1,
      action: "reply",
      body: "response wrapper",
    },
  }));
  assert.equal(nestedResponse.action, "reply");
  assert.equal(nestedResponse.body, "response wrapper");

  const choicesResponse = parseAgentResponse(JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            schema_version: 1,
            action: "Reply",
            body: "choices wrapper",
          }),
        },
      },
    ],
  }));
  assert.equal(choicesResponse.action, "reply");
  assert.equal(choicesResponse.body, "choices wrapper");

  const contentArrayResponse = parseAgentResponse(JSON.stringify({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          schema_version: 1,
          action: "\\\"reply\\\"",
          body: "content wrapper",
        }),
      },
    ],
  }));
  assert.equal(contentArrayResponse.action, "reply");
  assert.equal(contentArrayResponse.body, "content wrapper");
});

test("falls back to safe reply when OpenClaw payload text is non-json", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: "今日は軽めにいけそうです。",
      },
    ],
  }));

  assert.equal(response.action, "reply");
  assert.equal(response.body, "今日は軽めにいけそうです。");
  assert.equal(response.reason, "non_json_openclaw_text");
  assert.deepEqual(response.approval.mentions, []);
});

test("non-json text fallback preserves intentional line breaks", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: "  A=返信量: 短めでOK。  \n  B=安全gate: 自動返信可。  \n\n\n  C=followup: 作成なし。  ",
      },
    ],
  }));

  assert.equal(response.action, "reply");
  assert.equal(response.body, "A=返信量: 短めでOK。\nB=安全gate: 自動返信可。\n\nC=followup: 作成なし。");
  assert.equal(response.reason, "non_json_openclaw_text");
});

test("classifies OpenClaw error text without falling back to reply", () => {
  for (const [text, reason] of [
    [
      "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      "context_overflow",
    ],
    ["Error: maximum context length exceeded", "context_overflow"],
    ["Request failed: 500 internal server error", "openclaw_error_text"],
    ["OpenClaw error: failed to generate response", "openclaw_error_text"],
    ["RateLimitError: too many requests", "openclaw_error_text"],
    ["status=429 Too Many Requests", "openclaw_error_text"],
    ["status=503 Service Unavailable", "openclaw_error_text"],
    ["502 Bad Gateway", "openclaw_error_text"],
  ]) {
    const response = parseAgentResponse(JSON.stringify({
      payloads: [
        { text },
      ],
    }));

    assert.equal(response.action, "observe");
    assert.equal(response.reason, reason);
    assert.equal(response.body, "");
  }
});

test("classifies structured reply error body without posting it", () => {
  for (const [body, reason] of [
    ["Context overflow: prompt too large for the model.", "context_overflow"],
    ["Request failed: 500 internal server error", "openclaw_error_text"],
  ]) {
    const response = parseAgentResponse(JSON.stringify({
      schema_version: 1,
      action: "reply",
      body,
      reason: "high",
      confidence: "high",
    }));

    assert.equal(response.action, "observe");
    assert.equal(response.reason, reason);
    assert.equal(response.body, "");
  }
});

test("prefers latest structured error over earlier structured reply", () => {
  const response = parseAgentResponse([
    JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "古い返信",
      reason: "normal",
      confidence: "high",
    }),
    JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "Context overflow: prompt too large for the model.",
      reason: "normal",
      confidence: "high",
    }),
  ].join("\n"));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("prefers latest payload error over earlier payload reply in a single wrapper", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "古い返信",
          reason: "normal",
          confidence: "high",
        }),
      },
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "Context overflow: prompt too large for the model.",
          reason: "normal",
          confidence: "high",
        }),
      },
    ],
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("prefers latest raw payload error over earlier payload reply in a single wrapper", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "古い返信",
          reason: "normal",
          confidence: "high",
        }),
      },
      {
        text: "Context overflow: prompt too large for the model.",
      },
    ],
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("prefers non-payload error text over payload fallback reply", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      { text: "古い返信" },
    ],
    choices: [
      {
        message: {
          content: "Context overflow: prompt too large for the model.",
        },
      },
    ],
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("prefers trailing raw error or token over earlier structured reply", () => {
  for (const [trailing, reason] of [
    ["Context overflow: prompt too large for the model.", "context_overflow"],
    ["gho_1234567890abcdef1234567890abcdef1234", "secret_like_output"],
  ]) {
    const response = parseAgentResponse([
      JSON.stringify({
        schema_version: 1,
        action: "reply",
        body: "古い返信",
        reason: "normal",
        confidence: "high",
      }),
      trailing,
    ].join("\n"));

    assert.equal(response.action, "observe");
    assert.equal(response.reason, reason);
    assert.equal(response.body, "");
  }
});

test("does not turn bare provider tokens into fallback replies", () => {
  for (const text of [
    "ghp_1234567890abcdef1234567890abcdef1234",
    "gho_1234567890abcdef1234567890abcdef1234",
    "ghu_1234567890abcdef1234567890abcdef1234",
    "ghs_1234567890abcdef1234567890abcdef1234",
    "ghr_1234567890abcdef1234567890abcdef1234",
    "github_pat_1234567890abcdef1234567890abcdef",
    "AKIA1234567890ABCDEF",
    "sk-proj-1234567890abcdef",
    "token is sk-proj-1234567890abcdef.",
    "token is gho_1234567890abcdef1234567890abcdef1234.",
    "token is ghp_1234567890abcdef1234567890abcdef1234.",
    "abc=gho_1234567890abcdef1234567890abcdef1234",
    "x:ghu_1234567890abcdef1234567890abcdef1234",
    "url/ghs_1234567890abcdef1234567890abcdef1234",
  ]) {
    const response = parseAgentResponse(JSON.stringify({
      payloads: [
        { text },
      ],
    }));

    assert.equal(response.action, "observe");
    assert.equal(response.reason, "secret_like_output");
    assert.equal(response.body, "");
  }
});

test("prefers latest provider token over earlier safe reply", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "古い返信",
          reason: "normal",
          confidence: "high",
        }),
      },
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "reply",
          body: "abc=gho_1234567890abcdef1234567890abcdef1234",
          reason: "normal",
          confidence: "high",
        }),
      },
    ],
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "secret_like_output");
  assert.equal(response.body, "");
});

test("classifies structured provider token body without posting it", () => {
  for (const body of [
    "sk-proj-1234567890abcdef",
    "token is sk-proj-1234567890abcdef.",
    "abc=gho_1234567890abcdef1234567890abcdef1234",
    "x:ghu_1234567890abcdef1234567890abcdef1234",
    "url/ghs_1234567890abcdef1234567890abcdef1234",
  ]) {
    const response = parseAgentResponse(JSON.stringify({
      schema_version: 1,
      action: "reply",
      body,
      reason: "normal",
      confidence: "high",
    }));

    assert.equal(response.action, "observe");
    assert.equal(response.reason, "secret_like_output");
    assert.equal(response.body, "");
  }
});

test("removes provider tokens from followup summary and notes", () => {
  const response = normalizeOpenClawResponse({
    schema_version: 1,
    action: "observe",
    followup_candidates: [
      {
        summary: "url/ghs_1234567890abcdef1234567890abcdef1234",
        due_at: "2026-05-08T09:00:00+09:00",
        notes: "abc=gho_1234567890abcdef1234567890abcdef1234",
      },
    ],
  });

  assert.equal(response.followup_candidates[0].summary, "");
  assert.equal(response.followup_candidates[0].notes, "");
});

test("does not classify ordinary words ending in error as OpenClaw errors", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      { text: "terror is a word, not a model issue" },
    ],
  }));

  assert.equal(response.action, "reply");
  assert.equal(response.body, "terror is a word, not a model issue");
});

test("classifies raw stdout error text before unparseable fallback", () => {
  const response = parseAgentResponse(
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session."
  );

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("keeps classified failure observe ahead of non-json fallback text", () => {
  const response = parseAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          schema_version: 1,
          action: "observe",
          body: "",
          reason: "context_overflow",
        }),
      },
      {
        text: "今日は軽めにいけそうです。",
      },
    ],
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "context_overflow");
  assert.equal(response.body, "");
});

test("classifies non-json error text from choices and content wrappers", () => {
  const choicesResponse = parseAgentResponse(JSON.stringify({
    choices: [
      {
        message: {
          content: "Error: maximum context length exceeded",
        },
      },
    ],
  }));
  assert.equal(choicesResponse.action, "observe");
  assert.equal(choicesResponse.reason, "context_overflow");

  const contentResponse = parseAgentResponse(JSON.stringify({
    content: [
      {
        type: "text",
        text: "status=503 Service Unavailable",
      },
    ],
  }));
  assert.equal(contentResponse.action, "observe");
  assert.equal(contentResponse.reason, "openclaw_error_text");
});

test("does not fall back to reply for non-payload status text", () => {
  const response = parseAgentResponse(JSON.stringify({
    type: "status",
    message: "thinking",
  }));

  assert.equal(response.action, "observe");
  assert.equal(response.reason, "invalid_openclaw_response");
  assert.equal(response.body, "");
});

test("OpenClaw execution failure becomes safe observe response", async () => {
  await withServer({
    runAgentCommand: async () => {
      const error = new Error("timeout");
      error.code = "OPENCLAW_TIMEOUT";
      throw error;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_2",
        channel: { id: "1094907178671939654" },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.request_id, "req_2");
    assert.equal(body.diagnostics.reason_code, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.attempt_mode, "full_first");
    assert.equal(body.diagnostics.error_code, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.first_attempt_timeout_ms, baseConfig.firstAttemptTimeoutMs);
    assert.ok(body.diagnostics.prompt_chars > 0);
    assert.ok(body.diagnostics.elapsed_ms >= 0);
  });
});

test("OpenClaw execution failure omits unsafe freeform error code diagnostics", async () => {
  await withServer({
    runAgentCommand: async () => {
      const error = new Error("timeout with raw message");
      error.code = "timeout with spaces";
      throw error;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_unsafe_error_code",
        channel: { id: "1094907178671939654" },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "timeout with spaces");
    assert.deepEqual(body.diagnostics, {
      request_id: "req_unsafe_error_code",
      attempt_mode: "full_first",
      elapsed_ms: body.diagnostics.elapsed_ms,
      first_attempt_timeout_ms: baseConfig.firstAttemptTimeoutMs,
      prompt_chars: body.diagnostics.prompt_chars,
      first_attempt_elapsed_ms: body.diagnostics.first_attempt_elapsed_ms,
      last_stage: "openclaw_attempt_failed",
    });
    assert.ok(body.diagnostics.elapsed_ms >= 0);
    assert.ok(body.diagnostics.prompt_chars > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(body.diagnostics, "reason_code"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.diagnostics, "error_code"), false);
  });
});

test("minimal retry payload keeps only current-message decision fields", () => {
  const payload = buildMinimalRetryPayload({
    request_id: "req_retry",
    event_type: "message_create",
    received_at: "2026-05-06T06:40:00.000Z",
    guild_id: "guild_1",
    channel: {
      id: "channel_1",
      name: "raw channel name",
      type: "sandbox",
      registered: true,
    },
    message: {
      id: "msg_1",
      author_id: "user_1",
      author_display_name: "raw display",
      content: "x".repeat(800),
      created_at: "2026-05-06T06:40:00.000Z",
      is_reply_to_bot: false,
      mentions_bot: true,
      mentions_everyone: false,
      role_mentions: ["role_1".repeat(100)],
      attachments: [
        {
          id: "attachment_1".repeat(100),
          name: "raw attachment name".repeat(100),
          content_type: "image/png".repeat(100),
          size: 123,
        },
      ],
      links: ["https://example.com/".repeat(100)],
    },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: "raw recent content" },
      ],
      active_thread_age_minutes: 2,
      has_promised_followup: false,
      matched_followup_ids: ["due_1"],
    },
    memory: {
      member_ids: ["member_1"],
    },
  });

  assert.equal(payload.message.content.length, 500);
  assert.deepEqual(payload.context.recent_messages, []);
  assert.equal(payload.channel.name, undefined);
  assert.equal(payload.message.author_display_name, undefined);
  assert.equal(payload.memory, undefined);
  assert.deepEqual(payload.context.matched_followup_ids, ["due_1"]);
  assert.equal(payload.message.mentions_bot, true);
  assert.equal(payload.message.role_mentions[0].length, 80);
  assert.equal(payload.message.attachments[0].id.length, 80);
  assert.equal(payload.message.attachments[0].name, undefined);
  assert.deepEqual(payload.message.links, [{ present: true }]);
});

test("normal prompt payload removes raw display, links, and empty memory while preserving needed context", () => {
  const payload = buildPromptPayload({
    request_id: "req_normal_projection",
    channel: {
      id: "channel_1",
      name: "raw channel name",
      type: "chat",
      registered: true,
      thread_id: "thread_1",
    },
    message: {
      id: "msg_1",
      author_id: "user_1",
      author_display_name: "raw display",
      content: "さっきの https://example.com/raw-path の続きで短く返してください",
      mentions_bot: true,
      is_reply_to_bot: false,
      links: ["https://example.com/raw-path"],
      attachments: [{ id: "att_1", name: "raw filename.png", content_type: "image/png", size: 42 }],
    },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: `前のURL https://example.com/${"x".repeat(300)}`, created_at: "2026-05-06T06:39:00.000Z" },
      ],
      active_thread_age_minutes: 3,
      has_promised_followup: false,
      matched_followup_ids: [],
    },
    memory: { member_ids: [] },
  });

  assert.equal(payload.channel.name, undefined);
  assert.equal(payload.message.author_display_name, undefined);
  assert.match(payload.message.content, /\[external_url\]/);
  assert.doesNotMatch(payload.message.content, /https:\/\/example\.com/);
  assert.deepEqual(payload.message.links, [{ present: true }]);
  assert.equal(payload.message.attachments[0].name, undefined);
  assert.equal(payload.memory, undefined);
  assert.equal(payload.context.recent_messages.length, 1);
  assert.ok(payload.context.recent_messages[0].content.length <= 200);
  assert.match(payload.context.recent_messages[0].content, /\[external_url\]/);
  assert.doesNotMatch(payload.context.recent_messages[0].content, /https:\/\/example\.com/);
});

test("normal prompt payload drops recent context for self-contained direct smoke requests", () => {
  const payload = buildPromptPayload({
    request_id: "req_smoke_projection",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "live smoke S-1: 短い挨拶です。今の調子を一言で返してください。",
      mentions_bot: true,
    },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: "previous context", created_at: "2026-05-06T06:39:00.000Z" },
      ],
      has_promised_followup: false,
      matched_followup_ids: [],
    },
  });

  assert.deepEqual(payload.context.recent_messages, []);
});

test("normal prompt payload does not treat words containing ping as self-contained ping requests", () => {
  const payload = buildPromptPayload({
    request_id: "req_typing_projection",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "typing の件を短く返してください。",
      mentions_bot: true,
    },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: "typing context", created_at: "2026-05-06T06:39:00.000Z" },
      ],
      has_promised_followup: false,
      matched_followup_ids: [],
    },
  });

  assert.equal(payload.context.recent_messages.length, 1);
});

test("normal prompt payload keeps recent context for bot replies even when short", () => {
  const payload = buildPromptPayload({
    request_id: "req_reply_projection",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "一言で返してください。",
      mentions_bot: false,
      is_reply_to_bot: true,
    },
    context: {
      recent_messages: [
        { message_id: "ctx_1", author_id: "user_1", content: "reply antecedent context", created_at: "2026-05-06T06:39:00.000Z" },
      ],
      has_promised_followup: false,
      matched_followup_ids: [],
    },
  });

  assert.equal(payload.context.recent_messages.length, 1);
});

test("compact-first classification only accepts self-contained direct smoke requests", () => {
  const basePayload = {
    request_id: "req_compact",
    channel: { id: "channel_1", type: "sandbox", registered: true },
    message: {
      id: "msg_1",
      author_id: "user_1",
      content: "live smoke S-1: 短い挨拶です。今の調子を一言で返してください。",
      mentions_bot: true,
      is_reply_to_bot: false,
      mentions_everyone: false,
      role_mentions: [],
      attachments: [],
      links: [],
    },
    context: {
      recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "old" }],
      has_promised_followup: false,
      matched_followup_ids: [],
    },
  };

  assert.equal(isCompactFirstRequest(basePayload), true);
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content: "ping" } }), true);
  assert.equal(
    isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content: "挨拶してください" } }),
    true
  );
  assert.equal(
    isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content: "一言で返してください。" } }),
    false
  );
  assert.equal(
    isCompactFirstRequest({
      ...basePayload,
      message: { ...basePayload.message, content: "一言で返してください。" },
      context: { ...basePayload.context, recent_messages: [] },
    }),
    true
  );
  assert.equal(
    isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content: "さっきの続きで一言で返して" } }),
    false
  );
  for (const content of ["先ほどの件を一言で返してください", "先程の件を一言で返してください", "上記について一言で返して", "以前の話を一言で返して", "直前の件を一言で返して", "今の件を一言で返して"]) {
    assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content } }), false);
  }
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, is_reply_to_bot: true } }), false);
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, links: ["https://example.com"] } }), false);
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, attachments: [{ id: "a1" }] } }), false);
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, content: "@everyone ping" } }), false);
  assert.equal(isCompactFirstRequest({ ...basePayload, message: { ...basePayload.message, role_mentions: ["role_1"] } }), false);
  assert.equal(
    isCompactFirstRequest({ ...basePayload, context: { ...basePayload.context, matched_followup_ids: ["due_1"] } }),
    false
  );
});

test("required workspace context fails when default prompt file is missing", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missing-context-"));
  try {
    await assert.rejects(
      () => loadWorkspaceContext({
        workspaceDir,
        promptFiles: ["RUNTIME_PROMPT.md"],
        maxChars: 1200,
        required: true,
      }),
      /ENOENT|required workspace context/
    );
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("compact-first direct smoke skips workspace context and uses the short prompt on the first attempt", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, firstAttemptTimeoutMs: 321 },
    loadContext: async () => {
      throw new Error("compact-first must not load context");
    },
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "reply",
              body: "調子はよさそうです。",
              confidence: "high",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_compact_first",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "live smoke S-1: 短い挨拶です。今の調子を一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
          mentions_everyone: false,
          role_mentions: [],
          attachments: [],
          links: [],
        },
        context: {
          recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "raw recent content" }],
          has_promised_followup: false,
          matched_followup_ids: [],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "調子はよさそうです。");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 321);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.match(calls[0].message, /compact 判断 API/);
  assert.doesNotMatch(calls[0].message, /# Runtime files/);
  assert.doesNotMatch(calls[0].message, /raw recent content/);
});

test("optional prompt files are selected only from structured channel and followup signals", () => {
  assert.deepEqual(buildOptionalPromptFiles({
    channel: { type: "chat" },
    message: { content: "TOOLS.md を読んで" },
    context: { has_promised_followup: false, matched_followup_ids: [] },
  }), []);

  assert.deepEqual(buildOptionalPromptFiles({
    channel: { type: "ops" },
    context: { has_promised_followup: false, matched_followup_ids: [] },
  }).map((file) => file.path), ["TOOLS.md"]);

  assert.deepEqual(buildOptionalPromptFiles({
    channel: { type: "project" },
    context: { has_promised_followup: true, matched_followup_ids: [] },
  }).map((file) => file.path), ["OPEN_ITEMS.md"]);

  assert.deepEqual(buildOptionalPromptFiles({
    channel: { type: "ops" },
    context: { has_promised_followup: false, matched_followup_ids: ["due_1"] },
  }).map((file) => file.path), ["OPEN_ITEMS.md", "TOOLS.md"]);
});

test("full first attempt passes selected optional prompt files to workspace loader", async () => {
  const loadContextCalls = [];
  await withServer({
    config: {
      ...baseConfig,
      promptFiles: ["RUNTIME_PROMPT.md", "IDENTITY.md", "SOUL.md", "MEMORY.md"],
      maxWorkspaceContextChars: 4000,
    },
    loadContext: async (args) => {
      loadContextCalls.push(args);
      return "runtime context";
    },
    runAgentCommand: async () => JSON.stringify({
      payloads: [
        {
          text: JSON.stringify({
            schema_version: 1,
            action: "reply",
            body: "了解。",
            confidence: "high",
          }),
        },
      ],
    }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_optional_files",
        event_type: "manual_check",
        channel: { id: "840827137451229208", type: "ops", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "告知文の下書きを確認して",
          mentions_bot: true,
          is_reply_to_bot: true,
          mentions_everyone: false,
          role_mentions: [],
          attachments: [],
          links: [],
        },
        context: {
          recent_messages: [],
          has_promised_followup: true,
          matched_followup_ids: ["due_1"],
        },
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(loadContextCalls.length, 1);
  assert.equal(loadContextCalls[0].maxChars, 4000);
  assert.deepEqual(loadContextCalls[0].promptFiles.map((file) => typeof file === "string" ? file : file.path), [
    "RUNTIME_PROMPT.md",
    "IDENTITY.md",
    "SOUL.md",
    "MEMORY.md",
    "OPEN_ITEMS.md",
    "TOOLS.md",
  ]);
});

test("full first attempt is capped and reports safe attempt diagnostics", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, firstAttemptTimeoutMs: 250 },
    loadContext: async () => "runtime context",
    runAgentCommand: async ({ message, timeoutMs }) => {
      calls.push({ message, timeoutMs });
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "observe",
              body: "",
              reason: "openclaw_error_text",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_first_cap",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "さっきの続きで一言で返してください。",
          mentions_bot: true,
        },
        context: { recent_messages: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "openclaw_error_text");
    assert.equal(body.diagnostics.attempt_mode, "full_first");
    assert.equal(body.diagnostics.first_attempt_timeout_ms, 250);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 250);
  assert.match(calls[0].message, /# Runtime files/);
});

test("retries once with a minimal prompt when OpenClaw returns context_overflow", async () => {
  const calls = [];
  const logs = [];
  await withServer({
    logger: { info: (entry) => logs.push(entry), warn: () => {} },
    loadContext: async () => "x".repeat(1200),
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      if (calls.length === 1) {
        assert.match(message, /raw recent content/);
        assert.equal(sessionAttempt, undefined);
        return "Context overflow: prompt too large for the model.";
      }
      assert.doesNotMatch(message, /raw recent content/);
      assert.doesNotMatch(message, /# Runtime files/);
      assert.doesNotMatch(message, /\(no workspace context loaded\)/);
      assert.match(message, /前回は context overflow/);
      assert.equal(sessionAttempt, "retry-1");
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "reply",
              body: "いけます",
              confidence: "high",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_retry_success",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "さっきの話の続きで短く返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
          mentions_everyone: false,
          role_mentions: [],
          attachments: [],
          links: [],
        },
        context: {
          recent_messages: [
            { message_id: "ctx_1", author_id: "user_1", content: "raw recent content" },
          ],
          active_thread_age_minutes: 1,
          has_promised_followup: false,
          matched_followup_ids: [],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "いけます");
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].timeoutMs <= baseConfig.firstAttemptTimeoutMs);
  assert.ok(calls[1].timeoutMs <= baseConfig.requestTimeoutMs);
  assert.ok(calls[1].message.length < calls[0].message.length);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.equal(calls[1].sessionAttempt, "retry-1");
  const completed = logs.find((entry) => entry && entry.request_id === "req_retry_success");
  assert.equal(completed.retry_count, 1);
  assert.ok(completed.initial_prompt_chars > completed.retry_prompt_chars);
  assert.equal(completed.prompt_chars, completed.retry_prompt_chars);
});

test("does not retry context_overflow more than once", async () => {
  const calls = [];
  await withServer({
    runAgentCommand: async ({ message }) => {
      calls.push(message);
      return "Context overflow: prompt too large for the model.";
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_retry_fail",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "短く返してください",
          mentions_bot: true,
        },
        context: { recent_messages: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "context_overflow");
  });

  assert.equal(calls.length, 2);
});

test("skips context_overflow retry when the request deadline has too little time left", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, requestTimeoutMs: 1000, retryMinTimeoutMs: 1500 },
    runAgentCommand: async ({ message, timeoutMs }) => {
      calls.push({ message, timeoutMs });
      return "Context overflow: prompt too large for the model.";
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_retry_skipped",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "短く返してください",
          mentions_bot: true,
        },
        context: { recent_messages: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "context_overflow");
    assert.equal(body.diagnostics.retry_count, 0);
    assert.equal(body.diagnostics.retry_prompt_chars, 0);
    assert.equal(body.diagnostics.retry_skip_reason, "insufficient_time");
  });

  assert.equal(calls.length, 1);
});

test("keeps context_overflow as the response reason when retry execution times out", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, requestTimeoutMs: 1000, retryMinTimeoutMs: 150 },
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      if (calls.length === 1) {
        return "Context overflow: prompt too large for the model.";
      }
      const error = new Error("retry command timed out with raw text");
      error.code = "OPENCLAW_TIMEOUT";
      error.stage = "openclaw_timeout";
      error.stdout_bytes = 12;
      error.stderr_bytes = 34;
      error.stderr_line_count = 2;
      error.stderr_tail_hash = "abcdef1234567890";
      throw error;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_retry_timeout_preserve_context",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "短く返してください",
          mentions_bot: true,
        },
        context: { recent_messages: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "context_overflow");
    assert.equal(body.diagnostics.request_id, "req_retry_timeout_preserve_context");
    assert.equal(body.diagnostics.reason_code, "context_overflow");
    assert.equal(body.diagnostics.error_code, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.retry_count, 1);
    assert.ok(body.diagnostics.retry_prompt_chars > 0);
    assert.equal(body.diagnostics.retry_last_stage, "openclaw_timeout");
    assert.equal(body.diagnostics.retry_stdout_bytes, 12);
    assert.equal(body.diagnostics.retry_stderr_bytes, 34);
    assert.equal(body.diagnostics.retry_stderr_line_count, 2);
    assert.equal(body.diagnostics.retry_stderr_tail_hash, "abcdef1234567890");
    assert.doesNotMatch(JSON.stringify(body.diagnostics), /raw text/);
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].timeoutMs <= baseConfig.firstAttemptTimeoutMs);
  assert.ok(calls[1].timeoutMs >= baseConfig.retryMinTimeoutMs);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.equal(calls[1].sessionAttempt, "retry-1");
  assert.doesNotMatch(calls[1].message, /# Runtime files/);
});

test("retries with a compact prompt when the full first attempt times out with enough time left", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, requestTimeoutMs: 1000, firstAttemptTimeoutMs: 200, retryMinTimeoutMs: 150 },
    loadContext: async () => "runtime context".repeat(50),
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      if (calls.length === 1) {
        const error = new Error("first attempt timed out");
        error.code = "OPENCLAW_TIMEOUT";
        throw error;
      }
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "reply",
              body: "短く返します。",
              confidence: "high",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_first_timeout_retry",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "さっきの続きで一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
        },
        context: { recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "raw recent content" }] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "短く返します。");
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].timeoutMs, 200);
  assert.match(calls[0].message, /# Runtime files/);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.ok(calls[1].timeoutMs >= baseConfig.retryMinTimeoutMs);
  assert.equal(calls[1].sessionAttempt, "retry-1");
  assert.doesNotMatch(calls[1].message, /# Runtime files/);
  assert.doesNotMatch(calls[1].message, /raw recent content/);
});

test("retries with a compact prompt when the full first attempt exits before the client timeout", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, requestTimeoutMs: 1000, firstAttemptTimeoutMs: 200, retryMinTimeoutMs: 150 },
    loadContext: async () => "runtime context".repeat(50),
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      if (calls.length === 1) {
        const error = new Error("OpenClaw exited at its own deadline");
        error.code = "OPENCLAW_EXIT";
        throw error;
      }
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "reply",
              body: "短く復帰します。",
              confidence: "high",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_first_exit_retry",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "さっきの続きで一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
        },
        context: { recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "raw recent content" }] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "短く復帰します。");
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].timeoutMs, 200);
  assert.match(calls[0].message, /# Runtime files/);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.ok(calls[1].timeoutMs >= baseConfig.retryMinTimeoutMs);
  assert.equal(calls[1].sessionAttempt, "retry-1");
  assert.match(calls[1].message, /context overflow、timeout、または OpenClaw 実行失敗/);
  assert.doesNotMatch(calls[1].message, /# Runtime files/);
  assert.doesNotMatch(calls[1].message, /raw recent content/);
});

test("keeps retry diagnostics when a first timeout retry also fails", async () => {
  const calls = [];
  await withServer({
    config: { ...baseConfig, requestTimeoutMs: 1000, firstAttemptTimeoutMs: 200, retryMinTimeoutMs: 150 },
    loadContext: async () => "runtime context",
    runAgentCommand: async ({ message, timeoutMs, sessionAttempt }) => {
      calls.push({ message, timeoutMs, sessionAttempt });
      if (calls.length === 1) {
        const error = new Error("first attempt timed out");
        error.code = "OPENCLAW_TIMEOUT";
        throw error;
      }
      const error = new Error("retry failed raw https://example.com");
      error.code = "OPENCLAW_EXIT";
      error.stage = "openclaw_close";
      error.stdout_bytes = 56;
      error.stderr_bytes = 78;
      error.stderr_line_count = 3;
      error.stderr_tail_hash = "0123456789abcdef";
      throw error;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_first_timeout_retry_fails",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "さっきの続きで一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
        },
        context: { recent_messages: [{ message_id: "ctx_1", author_id: "user_1", content: "raw recent content" }] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.request_id, "req_first_timeout_retry_fails");
    assert.equal(body.diagnostics.reason_code, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.error_code, "OPENCLAW_EXIT");
    assert.equal(body.diagnostics.retry_count, 1);
    assert.ok(body.diagnostics.retry_prompt_chars > 0);
    assert.equal(body.diagnostics.retry_last_stage, "openclaw_close");
    assert.equal(body.diagnostics.retry_stdout_bytes, 56);
    assert.equal(body.diagnostics.retry_stderr_bytes, 78);
    assert.equal(body.diagnostics.retry_stderr_line_count, 3);
    assert.equal(body.diagnostics.retry_stderr_tail_hash, "0123456789abcdef");
    assert.doesNotMatch(JSON.stringify(body.diagnostics), /example\.com/);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionAttempt, undefined);
  assert.equal(calls[1].sessionAttempt, "retry-1");
  assert.doesNotMatch(calls[1].message, /# Runtime files/);
});

test("OpenClaw failure observe response includes safe diagnostics from request metrics", async () => {
  await withServer({
    loadContext: async () => "runtime context for diagnostics",
    runAgentCommand: async () => JSON.stringify({
      payloads: [
        {
          text: JSON.stringify({
            schema_version: 1,
            action: "reply",
            body: "Request failed: 500 internal server error",
            reason: "normal",
            confidence: "high",
          }),
        },
      ],
    }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_observe_diagnostics",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_1",
          author_id: "user_1",
          content: "短く返してください",
          mentions_bot: true,
        },
        context: { recent_messages: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "openclaw_error_text");
    assert.deepEqual(Object.keys(body.diagnostics).sort(), [
      "attempt_mode",
      "elapsed_ms",
      "first_attempt_elapsed_ms",
      "first_attempt_timeout_ms",
      "initial_prompt_chars",
      "last_stage",
      "prompt_chars",
      "reason_code",
      "request_id",
      "retry_count",
      "retry_elapsed_ms",
      "retry_prompt_chars",
      "stdout_bytes",
      "workspace_context_chars",
    ].sort());
    assert.equal(body.diagnostics.request_id, "req_observe_diagnostics");
    assert.equal(body.diagnostics.reason_code, "openclaw_error_text");
    assert.equal(body.diagnostics.attempt_mode, "full_first");
    assert.equal(body.diagnostics.first_attempt_timeout_ms, baseConfig.firstAttemptTimeoutMs);
    assert.equal(body.diagnostics.retry_count, 0);
    assert.equal(body.diagnostics.retry_prompt_chars, 0);
    assert.equal(body.diagnostics.retry_elapsed_ms, 0);
    assert.equal(body.diagnostics.workspace_context_chars, "runtime context for diagnostics".length);
    assert.equal(body.diagnostics.last_stage, "request_completed");
    assert.ok(body.diagnostics.stdout_bytes > 0);
    assert.ok(body.diagnostics.prompt_chars > 0);
    assert.equal(body.diagnostics.initial_prompt_chars, body.diagnostics.prompt_chars);
    assert.ok(body.diagnostics.first_attempt_elapsed_ms >= 0);
    assert.ok(body.diagnostics.elapsed_ms >= 0);
  });
});

test("request completed log keeps reason metadata bounded and redacted", async () => {
  const logs = [];
  await withServer({
    logger: { info: (entry) => logs.push(entry), warn: () => {} },
    runAgentCommand: async () => JSON.stringify({
      payloads: [
        {
          text: JSON.stringify({
            schema_version: 1,
            action: "observe",
            body: "",
            reason: `token=unsafe ${"x".repeat(200)}`,
          }),
        },
      ],
    }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_log",
        channel: { id: "1094907178671939654" },
      }),
    });
    assert.equal(response.status, 200);
  });

  const completed = logs.find((entry) => entry && entry.request_id === "req_log");
  assert.equal(completed.reason, "secret_like_output");
  assert.equal(completed.body_len, 0);
  assert.ok(completed.prompt_chars > 0);
  assert.ok(completed.workspace_context_chars >= 0);
});

test("request completed log only keeps allowlisted reason codes", async () => {
  const logs = [];
  for (const reason of [
    "normal",
    "ghp_1234567890abcdef1234567890abcdef1234",
    "gho_1234567890abcdef1234567890abcdef1234",
    "github_pat_1234567890abcdef1234567890abcdef",
    "AKIA1234567890ABCDEF",
    "sk-proj-1234567890abcdef",
    "context_overflow",
  ]) {
    await withServer({
      logger: { info: (entry) => logs.push(entry), warn: () => {} },
      runAgentCommand: async () => JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "observe",
              body: "",
              reason,
            }),
          },
        ],
      }),
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/discord/respond`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
        body: JSON.stringify({
          request_id: `req_log_reason_${logs.length}`,
          channel: { id: "1094907178671939654" },
        }),
      });
      assert.equal(response.status, 200);
    });
  }

  assert.deepEqual(logs.map((entry) => entry.reason), [
    "[freeform]",
    "secret_like_output",
    "secret_like_output",
    "secret_like_output",
    "secret_like_output",
    "secret_like_output",
    "context_overflow",
  ]);
});

test("request completed log does not keep freeform reason text", async () => {
  const logs = [];
  await withServer({
    logger: { info: (entry) => logs.push(entry), warn: () => {} },
    runAgentCommand: async () => JSON.stringify({
      payloads: [
        {
          text: JSON.stringify({
            schema_version: 1,
            action: "observe",
            body: "",
            reason: "短い挨拶です。今の調子を一言で返してください。",
          }),
        },
      ],
    }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_log_freeform",
        channel: { id: "1094907178671939654" },
      }),
    });
    assert.equal(response.status, 200);
  });

  const completed = logs.find((entry) => entry && entry.request_id === "req_log_freeform");
  assert.equal(completed.reason, "[freeform]");
});

test("trace logs expose request stage boundaries without raw prompt text", async () => {
  const logs = [];
  const calls = [];
  await withServer({
    config: { ...baseConfig, traceLogs: true },
    logger: { info: (entry) => logs.push(entry), warn: () => {} },
    runAgentCommand: async ({ message, traceLogs, requestId, attempt, attemptMode }) => {
      calls.push({ message, traceLogs, requestId, attempt, attemptMode });
      return JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              schema_version: 1,
              action: "reply",
              body: "確認しました",
              confidence: "high",
            }),
          },
        ],
      });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_trace",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_trace",
          author_id: "user_1",
          content: "短い挨拶です。今の調子を一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
          mentions_everyone: false,
          role_mentions: [],
          attachments: [],
          links: [],
        },
        context: {
          recent_messages: [],
          active_thread_age_minutes: 1,
          has_promised_followup: false,
          matched_followup_ids: [],
        },
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].traceLogs, true);
  assert.equal(calls[0].requestId, "req_trace");
  assert.equal(calls[0].attempt, "first");
  assert.equal(calls[0].attemptMode, "compact_first");
  const stages = logs.map((entry) => entry.stage).filter(Boolean);
  assert.deepEqual(stages, [
    "request_received",
    "prompt_built",
    "openclaw_attempt_start",
    "openclaw_attempt_end",
    "openclaw_parse_start",
    "openclaw_parse_end",
    "request_completed",
  ]);
  assert.ok(logs.every((entry) => entry.request_id === "req_trace"));
  assert.ok(logs.some((entry) => entry.stage === "prompt_built" && entry.prompt_chars > 0));
  assert.ok(!JSON.stringify(logs).includes("短い挨拶です"));
});

test("timeout diagnostics include last stage and retry skip reason", async () => {
  await withServer({
    config: {
      ...baseConfig,
      requestTimeoutMs: 800,
      firstAttemptTimeoutMs: 750,
      retryMinTimeoutMs: 1000,
      traceLogs: true,
    },
    runAgentCommand: async () => {
      const error = new Error("OpenClaw command timed out: timeoutMs=750");
      error.code = "OPENCLAW_TIMEOUT";
      error.stage = "openclaw_timeout";
      error.stdout_bytes = 0;
      error.stderr_bytes = 0;
      throw error;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_timeout_diag",
        channel: { id: "1094907178671939654", type: "sandbox", registered: true },
        message: {
          id: "msg_timeout",
          author_id: "user_1",
          content: "短い挨拶です。今の調子を一言で返してください。",
          mentions_bot: true,
          is_reply_to_bot: false,
          mentions_everyone: false,
          role_mentions: [],
          attachments: [],
          links: [],
        },
        context: {
          recent_messages: [],
          active_thread_age_minutes: 1,
          has_promised_followup: false,
          matched_followup_ids: [],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reason, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.last_stage, "openclaw_timeout");
    assert.equal(body.diagnostics.retry_skip_reason, "insufficient_time");
    assert.equal(body.diagnostics.error_code, "OPENCLAW_TIMEOUT");
    assert.equal(body.diagnostics.stdout_bytes, 0);
    assert.equal(body.diagnostics.stderr_bytes, 0);
  });
});

test("buildOpenClawArgs uses local embedded agent by default", () => {
  assert.deepEqual(
    buildOpenClawArgs({
      agentMode: "local",
      sessionId: "session",
      thinking: "low",
      timeoutSeconds: 60,
      message: "hello",
    }),
    [
      "agent",
      "--json",
      "--local",
      "--session-id",
      "session",
      "--thinking",
      "low",
      "--timeout",
      "60",
      "--message",
      "hello",
    ]
  );
});

test("request scoped session id uses request id without embedding raw prompt content", () => {
  const sessionId = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1",
    sessionScope: "request",
    message: [
      "# Discord payload",
      "```json",
      JSON.stringify({
        request_id: "req:abc 123",
        content: "secret raw discord body",
      }),
      "```",
    ].join("\n"),
  });

  assert.match(sessionId, /^dokobasho-fairy-discord-v1-req-[0-9a-f]{16}$/);
  assert.equal(sessionId.length <= 64, true);
  assert.doesNotMatch(sessionId, /req:abc|abc-123/);
  assert.doesNotMatch(sessionId, /secret raw discord body/);
});

test("request scoped retry session id appends a safe attempt suffix", () => {
  const sessionId = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1",
    sessionScope: "request",
    message: [
      "# Discord payload",
      "```json",
      JSON.stringify({
        request_id: "req:abc 123",
        content: "secret raw discord body",
      }),
      "```",
    ].join("\n"),
    sessionAttempt: "retry 1",
  });

  assert.match(sessionId, /^dokobasho-fairy-discord-v1-req-[0-9a-f]{16}-retry-1$/);
  assert.equal(sessionId.length <= 64, true);
  assert.doesNotMatch(sessionId, /req:abc|abc-123/);
  assert.doesNotMatch(sessionId, /secret raw discord body/);
});

test("request scoped session id falls back to a prompt hash and fixed scope keeps base id", () => {
  const scoped = buildRequestScopedSessionId({
    sessionId: "base-session",
    sessionScope: "request",
    message: "prompt with secret value",
  });
  assert.match(scoped, /^base-session-prompt-[0-9a-f]{16}$/);
  assert.equal(scoped.length <= 64, true);
  assert.doesNotMatch(scoped, /secret value/);

  assert.equal(
    buildRequestScopedSessionId({
      sessionId: "base-session",
      sessionScope: "fixed",
      requestId: "req_1",
      message: "prompt",
    }),
    "base-session"
  );
});

test("request scoped session id keeps uuid and retry attempts within OpenClaw cache key limit", () => {
  const requestId = "61de62ad-b7ba-44f0-b4b0-69453b159743";
  const first = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1",
    sessionScope: "request",
    requestId,
    message: "prompt",
  });
  const retry = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1",
    sessionScope: "request",
    requestId,
    message: "prompt",
    sessionAttempt: "retry-1",
  });

  assert.equal(first.length <= 64, true);
  assert.equal(retry.length <= 64, true);
  assert.notEqual(first, retry);
  assert.doesNotMatch(first, /61de62ad|b7ba|159743/);
  assert.doesNotMatch(retry, /61de62ad|b7ba|159743/);
  assert.match(first, /^dokobasho-fairy-discord-v1-req-[0-9a-f]{16}$/);
  assert.match(retry, /^dokobasho-fairy-discord-v1-req-[0-9a-f]{16}-retry-1$/);
});

test("long session ids and attempts are shortened without losing retry separation", () => {
  const first = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1-extra-long-session-name-that-would-overflow",
    sessionScope: "request",
    requestId: "req_1",
    message: "prompt",
  });
  const retry = buildRequestScopedSessionId({
    sessionId: "dokobasho-fairy-discord-v1-extra-long-session-name-that-would-overflow",
    sessionScope: "request",
    requestId: "req_1",
    message: "prompt",
    sessionAttempt: "retry attempt name that is far too long to pass through directly",
  });

  assert.equal(first.length <= 64, true);
  assert.equal(retry.length <= 64, true);
  assert.notEqual(first, retry);
  assert.match(retry, /-attempt-[0-9a-f]{16}$/);
});

test("session id hashes use raw values before output normalization to avoid collisions", () => {
  const requestA = buildRequestScopedSessionId({
    sessionId: "base-session",
    sessionScope: "request",
    requestId: "req abc",
    message: "prompt",
  });
  const requestB = buildRequestScopedSessionId({
    sessionId: "base-session",
    sessionScope: "request",
    requestId: "req/abc",
    message: "prompt",
  });
  assert.notEqual(requestA, requestB);
  assert.equal(requestA.length <= 64, true);
  assert.equal(requestB.length <= 64, true);

  const nonAsciiRequest = buildRequestScopedSessionId({
    sessionId: "base-session",
    sessionScope: "request",
    requestId: "要求一",
    message: "prompt",
  });
  assert.match(nonAsciiRequest, /^base-session-req-[0-9a-f]{16}$/);
  assert.equal(nonAsciiRequest.length <= 64, true);

  const longBaseA = buildRequestScopedSessionId({
    sessionId: `${"x".repeat(96)}A`,
    sessionScope: "fixed",
    message: "prompt",
  });
  const longBaseB = buildRequestScopedSessionId({
    sessionId: `${"x".repeat(96)}B`,
    sessionScope: "fixed",
    message: "prompt",
  });
  assert.notEqual(longBaseA, longBaseB);
  assert.equal(longBaseA.length <= 64, true);
  assert.equal(longBaseB.length <= 64, true);
});

test("fixed scoped retry session id is separated from the base session", () => {
  assert.equal(
    buildRequestScopedSessionId({
      sessionId: "base-session",
      sessionScope: "fixed",
      requestId: "req_1",
      message: "prompt with secret value",
      sessionAttempt: "retry-1",
    }),
    "base-session-retry-1"
  );
});

test("long fixed scoped session id is bounded for OpenClaw cache key limit", () => {
  const first = buildRequestScopedSessionId({
    sessionId: "fixed-session-name-that-is-longer-than-openclaw-cache-key-allows-and-needs-shortening",
    sessionScope: "fixed",
    requestId: "req_1",
    message: "prompt",
  });
  const retry = buildRequestScopedSessionId({
    sessionId: "fixed-session-name-that-is-longer-than-openclaw-cache-key-allows-and-needs-shortening",
    sessionScope: "fixed",
    requestId: "req_1",
    message: "prompt",
    sessionAttempt: "retry-1",
  });

  assert.equal(first.length <= 64, true);
  assert.equal(retry.length <= 64, true);
  assert.notEqual(first, retry);
  assert.match(retry, /-retry-1$/);
});

test("OpenClaw runner removes request-scoped session state after successful agent run", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-cleanup-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-cleanup-"));
  const commandPath = path.join(workspaceDir, "openclaw-stub.js");
  await fs.writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const sessionIndex = process.argv.indexOf('--session-id');",
      "const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'missing-session';",
      "const stateDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "fs.writeFileSync(path.join(stateDir, `${sessionId}.jsonl`), 'raw smoke body that must not persist');",
      "fs.writeFileSync(path.join(stateDir, `${sessionId}.trajectory.jsonl`), 'raw smoke trajectory that must not persist');",
      "process.stdout.write(JSON.stringify({ action: 'reply', body: 'ok' }));",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(commandPath, 0o700);
  const logs = [];
  const requestId = "req_runner_cleanup";
  const message = JSON.stringify({ request_id: requestId, content: "raw smoke body that must not persist" });
  const expectedSessionId = buildRequestScopedSessionId({
    sessionId: baseConfig.sessionId,
    sessionScope: baseConfig.sessionScope,
    requestId,
    message,
  });
  const statePaths = buildOpenClawSessionStatePaths({ homeDir, sessionId: expectedSessionId });
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const stdout = await runOpenClawAgent({
      config: {
        ...baseConfig,
        command: commandPath,
        workspaceDir,
      },
      message,
      timeoutMs: 1000,
      logger: { info: (entry) => logs.push(entry) },
      traceLogs: true,
      requestId,
      channelId: "1094907178671939654",
      attempt: "first",
      attemptMode: "compact_first",
    });
    assert.equal(stdout, JSON.stringify({ action: "reply", body: "ok" }));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  for (const statePath of statePaths) {
    await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
  }
  const cleanupLog = logs.find((entry) => entry.stage === "openclaw_session_cleanup_end");
  assert.equal(cleanupLog.removed_paths, 2);
  assert.ok(!JSON.stringify(logs).includes("raw smoke body"));
});

test("OpenClaw session state cleanup only targets safe session file names", () => {
  assert.deepEqual(buildOpenClawSessionStatePaths({ homeDir: "/tmp/home", sessionId: "../escape" }), []);
  assert.deepEqual(buildOpenClawSessionStatePaths({ homeDir: "/tmp/home", sessionId: "nested/session" }), []);
  assert.deepEqual(buildOpenClawSessionStatePaths({ homeDir: "/tmp/home", sessionId: "session with spaces" }), []);
  assert.deepEqual(buildOpenClawSessionStatePaths({ homeDir: "", sessionId: "safe-session" }), []);
  assert.deepEqual(
    buildOpenClawSessionStatePaths({ homeDir: "/tmp/home", sessionId: "safe-session_1:req.2" }),
    [
      "/tmp/home/.openclaw/agents/main/sessions/safe-session_1:req.2.jsonl",
      "/tmp/home/.openclaw/agents/main/sessions/safe-session_1:req.2.trajectory.jsonl",
    ]
  );
});

test("OpenClaw runner fails the request when session state cleanup fails", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-cleanup-fail-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-cleanup-fail-"));
  const commandPath = path.join(workspaceDir, "openclaw-stub.js");
  await fs.writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(JSON.stringify({ action: 'reply', body: 'ok' }));",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(commandPath, 0o700);
  const requestId = "req_runner_cleanup_failure";
  const message = JSON.stringify({ request_id: requestId, content: "raw body" });
  const expectedSessionId = buildRequestScopedSessionId({
    sessionId: baseConfig.sessionId,
    sessionScope: baseConfig.sessionScope,
    requestId,
    message,
  });
  const [sessionPath] = buildOpenClawSessionStatePaths({ homeDir, sessionId: expectedSessionId });
  await fs.mkdir(sessionPath, { recursive: true });
  const warnings = [];
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await assert.rejects(
      runOpenClawAgent({
        config: {
          ...baseConfig,
          command: commandPath,
          workspaceDir,
        },
        message,
        timeoutMs: 1000,
        logger: { info: () => {}, warn: (entry) => warnings.push(entry) },
        traceLogs: false,
        requestId,
        channelId: "1094907178671939654",
        attempt: "first",
        attemptMode: "compact_first",
      }),
      { code: "OPENCLAW_SESSION_CLEANUP_FAILED" }
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].stage, "openclaw_session_cleanup_error");
  assert.equal(warnings[0].request_id, requestId);
});

test("OpenClaw runner trace logs child process timeout lifecycle", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-trace-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-trace-"));
  const commandPath = path.join(workspaceDir, "openclaw-stub.js");
  await fs.writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const sessionIndex = process.argv.indexOf('--session-id');",
      "const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'missing-session';",
      "const stateDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "fs.writeFileSync(path.join(stateDir, `${sessionId}.jsonl`), 'raw secret body');",
      "fs.writeFileSync(path.join(stateDir, `${sessionId}.trajectory.jsonl`), 'raw secret trajectory');",
      "process.stderr.write('Request failed at https://example.com/raw token=abcdefsecret\\n');",
      "setTimeout(() => {}, 5000);",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(commandPath, 0o700);
  const logs = [];
  let closeLog;
  const closeObserved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("openclaw_close trace not observed")), 1000);
    logs.onInfo = (entry) => {
      logs.push(entry);
      if (entry.stage === "openclaw_close") {
        closeLog = entry;
        clearTimeout(timer);
        resolve();
      }
    };
  });

  const message = JSON.stringify({ request_id: "req_runner_trace", content: "raw secret body" });
  const expectedSessionId = buildRequestScopedSessionId({
    sessionId: baseConfig.sessionId,
    sessionScope: baseConfig.sessionScope,
    requestId: "req_runner_trace",
    message,
  });
  const statePaths = buildOpenClawSessionStatePaths({ homeDir, sessionId: expectedSessionId });
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await assert.rejects(
      runOpenClawAgent({
        config: {
          ...baseConfig,
          command: commandPath,
          workspaceDir,
          requestTimeoutMs: 750,
          timeoutSeconds: 5,
        },
        message,
        timeoutMs: 750,
        logger: { info: (entry) => logs.onInfo(entry) },
        traceLogs: true,
        requestId: "req_runner_trace",
        channelId: "1094907178671939654",
        attempt: "first",
        attemptMode: "compact_first",
      }),
      /timed out/
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  const stages = logs.map((entry) => entry.stage);
  assert.ok(stages.includes("openclaw_spawn_start"));
  assert.ok(stages.includes("openclaw_spawned"));
  assert.ok(stages.includes("openclaw_timeout_signal_sent"));
  assert.ok(stages.includes("openclaw_session_cleanup_end"));
  await closeObserved;
  for (const statePath of statePaths) {
    await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
  }
  assert.equal(closeLog.close_code, -1);
  assert.equal(closeLog.close_signal, "SIGTERM");
  assert.equal(closeLog.timed_out, true);
  const timeoutLog = logs.find((entry) => entry.stage === "openclaw_timeout_signal_sent");
  assert.equal(timeoutLog.stderr_line_count, 1);
  assert.match(timeoutLog.stderr_tail_hash, /^[0-9a-f]{16}$/);
  assert.match(timeoutLog.stderr_tail_safe, /\[url\]/);
  assert.doesNotMatch(timeoutLog.stderr_tail_safe, /example\.com/);
  assert.doesNotMatch(timeoutLog.stderr_tail_safe, /abcdefsecret/);
  assert.ok(logs.every((entry) => entry.request_id === "req_runner_trace"));
  assert.ok(!JSON.stringify(logs).includes("raw secret body"));
});

test("OpenClaw runner removes session state written during SIGTERM shutdown", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-late-cleanup-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-late-cleanup-"));
  const commandPath = path.join(workspaceDir, "openclaw-stub.js");
  await fs.writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const sessionIndex = process.argv.indexOf('--session-id');",
      "const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'missing-session';",
      "const stateDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "process.on('SIGTERM', () => {",
      "  fs.writeFileSync(path.join(stateDir, `${sessionId}.jsonl`), 'late raw secret body');",
      "  fs.writeFileSync(path.join(stateDir, `${sessionId}.trajectory.jsonl`), 'late raw secret trajectory');",
      "  setTimeout(() => process.exit(143), 25);",
      "});",
      "setTimeout(() => {}, 5000);",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(commandPath, 0o700);

  const requestId = "req_runner_late_cleanup";
  const message = JSON.stringify({ request_id: requestId, content: "raw body" });
  const expectedSessionId = buildRequestScopedSessionId({
    sessionId: baseConfig.sessionId,
    sessionScope: baseConfig.sessionScope,
    requestId,
    message,
  });
  const statePaths = buildOpenClawSessionStatePaths({ homeDir, sessionId: expectedSessionId });
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await assert.rejects(
      runOpenClawAgent({
        config: {
          ...baseConfig,
          command: commandPath,
          workspaceDir,
          requestTimeoutMs: 100,
          timeoutSeconds: 1,
        },
        message,
        timeoutMs: 100,
        logger: { info: () => {}, warn: () => {} },
        traceLogs: true,
        requestId,
        channelId: "1094907178671939654",
        attempt: "first",
        attemptMode: "compact_first",
      }),
      /timed out/
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  for (const statePath of statePaths) {
    await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
  }
});

test("OpenClaw child env keeps runtime secrets out of the agent process", () => {
  const childEnv = buildOpenClawChildEnv({
    HOME: "/root",
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    OPENCLAW_API_KEY: "synthetic-api-key",
    BOT_TOKEN: "synthetic-bot-token",
    N8N_WEBHOOK_SECRET: "synthetic-webhook-secret",
    NOTION_TOKEN: "synthetic-notion-token",
  });

  assert.equal(childEnv.HOME, "/root");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.LANG, "C.UTF-8");
  assert.equal(childEnv.OPENCLAW_API_KEY, undefined);
  assert.equal(childEnv.BOT_TOKEN, undefined);
  assert.equal(childEnv.N8N_WEBHOOK_SECRET, undefined);
  assert.equal(childEnv.NOTION_TOKEN, undefined);
});

test("loadConfig defaults to request scoped sessions with fixed compatibility opt-out", () => {
  const config = loadConfig({ OPENCLAW_API_KEY: "secret" });
  assert.equal(config.sessionScope, "request");
  assert.equal(config.timeoutSeconds, 120);
  assert.equal(config.requestTimeoutMs, 160000);
  assert.equal(config.retryMinTimeoutMs, 60000);
  assert.equal(config.killGraceMs, 10000);
  assert.equal(config.traceLogs, false);
  assert.equal(config.cleanupSessionState, true);
  assert.equal(config.maxWorkspaceContextChars, 4000);
  assert.equal(config.promptFiles.includes("TOOLS.md"), false);
  assert.equal(config.promptFiles.includes("OPEN_ITEMS.md"), false);
  assert.equal(config.promptFiles.includes("ROADMAP.md"), false);
  assert.deepEqual(config.promptFiles, ["RUNTIME_PROMPT.md", "IDENTITY.md", "SOUL.md", "MEMORY.md"]);
  assert.equal(loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_AGENT_SESSION_SCOPE: "fixed",
  }).sessionScope, "fixed");
  assert.equal(loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_CLEANUP_SESSION_STATE: "0",
  }).cleanupSessionState, false);
});
