"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS, loadConfig } = require("../src/config");
const { buildOpenClawArgs, buildOpenClawChildEnv, buildRequestScopedSessionId } = require("../src/openclaw-runner");
const { buildMinimalRetryPayload, buildPromptPayload, createServer } = require("../src/server");
const {
  buildAgentPrompt,
  buildObserveResponse,
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

test("normalizes diagnostics to whitelisted structured fields only", () => {
  assert.deepEqual(normalizeSafeDiagnostics({
    request_id: "req_1",
    reason_code: "context_overflow",
    elapsed_ms: 12.9,
    prompt_chars: "120",
    initial_prompt_chars: 140,
    retry_count: 1,
    retry_prompt_chars: 80,
    workspace_context_chars: 40,
    error_code: "OPENCLAW_TIMEOUT",
    stdout: "raw stdout",
    prompt: "raw prompt",
    stack: "Error stack",
    message: "freeform error",
    url: "https://example.com/raw",
  }), {
    request_id: "req_1",
    reason_code: "context_overflow",
    elapsed_ms: 12,
    prompt_chars: 120,
    initial_prompt_chars: 140,
    retry_count: 1,
    retry_prompt_chars: 80,
    workspace_context_chars: 40,
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

  assert.ok(prompt.length < 7000);
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
    assert.equal(body.diagnostics.error_code, "OPENCLAW_TIMEOUT");
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
      elapsed_ms: body.diagnostics.elapsed_ms,
    });
    assert.ok(body.diagnostics.elapsed_ms >= 0);
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

test("retries once with a minimal prompt when OpenClaw returns context_overflow", async () => {
  const calls = [];
  const logs = [];
  await withServer({
    logger: { info: (entry) => logs.push(entry), warn: () => {} },
    loadContext: async () => "x".repeat(1200),
    runAgentCommand: async ({ message }) => {
      calls.push(message);
      if (calls.length === 1) {
        assert.match(message, /raw recent content/);
        return "Context overflow: prompt too large for the model.";
      }
      assert.doesNotMatch(message, /raw recent content/);
      assert.match(message, /\(no workspace context loaded\)/);
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
  assert.ok(calls[1].length < calls[0].length);
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
      "elapsed_ms",
      "initial_prompt_chars",
      "prompt_chars",
      "reason_code",
      "request_id",
      "retry_count",
      "retry_prompt_chars",
      "workspace_context_chars",
    ].sort());
    assert.equal(body.diagnostics.request_id, "req_observe_diagnostics");
    assert.equal(body.diagnostics.reason_code, "openclaw_error_text");
    assert.equal(body.diagnostics.retry_count, 0);
    assert.equal(body.diagnostics.retry_prompt_chars, 0);
    assert.equal(body.diagnostics.workspace_context_chars, "runtime context for diagnostics".length);
    assert.ok(body.diagnostics.prompt_chars > 0);
    assert.equal(body.diagnostics.initial_prompt_chars, body.diagnostics.prompt_chars);
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

  assert.equal(sessionId, "dokobasho-fairy-discord-v1-req-req:abc-123");
  assert.doesNotMatch(sessionId, /secret raw discord body/);
});

test("request scoped session id falls back to a prompt hash and fixed scope keeps base id", () => {
  const scoped = buildRequestScopedSessionId({
    sessionId: "base-session",
    sessionScope: "request",
    message: "prompt with secret value",
  });
  assert.match(scoped, /^base-session-req-prompt-[0-9a-f]{16}$/);
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
  assert.equal(config.requestTimeoutMs, 140000);
  assert.equal(config.maxWorkspaceContextChars, 1200);
  assert.equal(config.promptFiles.includes("TOOLS.md"), false);
  assert.deepEqual(config.promptFiles, ["RUNTIME_PROMPT.md"]);
  assert.equal(loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_AGENT_SESSION_SCOPE: "fixed",
  }).sessionScope, "fixed");
});
