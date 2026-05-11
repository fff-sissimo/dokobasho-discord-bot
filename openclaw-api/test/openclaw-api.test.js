"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { loadConfig } = require("../src/config");
const { buildOpenClawArgs, buildOpenClawChildEnv, buildRequestScopedSessionId } = require("../src/openclaw-runner");
const { createServer } = require("../src/server");
const {
  buildAgentPrompt,
  buildDirectAgentPrompt,
  buildObserveResponse,
  normalizeDirectReplyText,
  normalizeOpenClawResponse,
  parseAgentResponse,
  parseDirectAgentResponse,
} = require("../src/contracts");
const { buildDispatchPayload, createN8nDispatcher } = require("../src/n8n-dispatcher");
const { createNotionBridge, extractNotionId } = require("../src/notion-bridge");

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
  sessionScope: "request",
  promptFiles: ["AGENTS.md"],
  notion: {
    enabled: false,
    token: "",
    version: "2025-09-03",
    baseUrl: "https://api.notion.com/v1",
    maxResults: 5,
    maxResultChars: 4000,
  },
  n8nDispatch: {
    enabled: false,
    url: "",
    secret: "",
    allowedWorkflows: ["notion.safe_ops"],
    timeoutMs: 20000,
  },
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
      notion_requests: [],
      notion_writes: [],
      n8n_workflow_requests: [],
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
  ]);
});

test("invalid OpenClaw output becomes observe response", () => {
  const response = parseAgentResponse("not json");
  assert.equal(response.action, "observe");
  assert.equal(response.reason, "unparseable_openclaw_output");
});

test("agent prompt includes phase2 chat restraint rules", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: "runtime context",
    payload: {
      channel: { id: "840827137451229210", type: "chat" },
      context: { active_thread_age_minutes: 31 },
    },
  });

  assert.match(prompt, /channel\.type が chat/);
  assert.match(prompt, /active_thread_age_minutes が 30 を超える/);
  assert.match(prompt, /checked_followup_ids/);
  assert.match(prompt, /closed_followup_ids/);
  assert.match(prompt, /notion_requests/);
  assert.match(prompt, /notion_writes/);
  assert.match(prompt, /metadata\.kind/);
  assert.match(prompt, /explicit_request, agreed_todo, formal_quest, creation_continuation, test_only/);
  assert.match(prompt, /metadata\.basis/);
  assert.match(prompt, /explicit_user_request, agreed_in_thread, due_followup, unknown/);
  assert.match(prompt, /due followup を一度確認したら/);
  assert.match(prompt, /ID だけを入れ、raw 本文は入れない/);
});

test("agent prompt includes channel active thread and output policies", () => {
  const prompt = buildAgentPrompt({
    workspaceContext: "runtime context",
    payload: {
      channel: { id: "840827137451229210", type: "board" },
      context: { active_thread_age_minutes: 31 },
    },
  });

  assert.match(prompt, /board: current request only/);
  assert.match(prompt, /proactive な再開/);
  assert.match(prompt, /未採用アイデア.*stable memory/);
  assert.match(prompt, /project 昇格の確認/);
  assert.match(prompt, /project: active thread は 24h/);
  assert.match(prompt, /proactive window は 6h/);
  assert.match(prompt, /active_thread_age_minutes が 1440/);
  assert.match(prompt, /active_thread_age_minutes が 360/);
  assert.match(prompt, /creation: 本人が求めた相談/);
  assert.match(prompt, /自発会話を始めることは基本しない/);
  assert.match(prompt, /ops: 原則として送信しない/);
  assert.match(prompt, /公開告知、運営判断/);
  assert.match(prompt, /draft、publish_blocked、または requires_approval: true/);
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
  assert.match(prompt, /一般 URL の本文やリンク先内容を自動取得・要約・記憶しない/);
  assert.match(prompt, /raw Discord 本文、秘密値、未加工の会話ログは保存・出力しない/);
});

test("normalizes Notion requests and drops destructive operations", () => {
  const response = normalizeOpenClawResponse({
    schema_version: 1,
    action: "observe",
    notion_requests: [
      { id: "read_1", operation: "search", query: "どこでもない場所", page_size: 20 },
      { id: "bad", operation: "delete_page", target: { id: "abc" } },
    ],
    notion_writes: [
      {
        id: "write_1",
        operation: "append_blocks",
        target: { url: "https://www.notion.so/example-0123456789abcdef0123456789abcdef", type: "page" },
        body: "追記します",
      },
      { id: "bad_write", operation: "archive_page", target: { id: "abc" } },
    ],
  });

  assert.deepEqual(response.notion_requests, [
    {
      id: "read_1",
      operation: "search",
      query: "どこでもない場所",
      target: { id: "", url: "", type: "" },
      page_size: 10,
    },
  ]);
  assert.equal(response.notion_writes.length, 1);
  assert.equal(response.notion_writes[0].operation, "append_blocks");
  assert.equal(response.notion_writes[0].body, "追記します");
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
  assert.match(prompt, /公開告知、運営判断、チャンネル方針、外部向け文面は draft/);
  assert.match(prompt, /publish_blocked、または requires_approval: true/);
  assert.match(prompt, /approval\.mentions は常に空配列/);
});

test("direct agent prompt includes direct handoff safety boundaries", () => {
  const prompt = buildDirectAgentPrompt({
    workspaceContext: "runtime context",
    payload: {
      request_id: "req_direct_prompt",
      execution: { mode: "direct_agent", reason: "notion_target" },
      message: {
        web_targets: [{ url: "https://example.com/report", hostname: "example.com" }],
      },
      context: {
        conversation: {
          scope: "thread",
          fetched_messages: 80,
          used_messages: 42,
          truncated: true,
          target_fetches: 1,
        },
        recent_messages: [
          {
            message_id: "ctx_1",
            author_id: "bot_1",
            author_is_bot: true,
            context_source: "reply_reference",
            content: "前回の返答",
          },
        ],
      },
    },
  });

  assert.match(prompt, /Discord へ直接投稿しない/);
  assert.match(prompt, /最終報告だけ/);
  assert.match(prompt, /n8n_workflow_requests/);
  assert.match(prompt, /Notion MCP、Notion token、n8n webhook secret/);
  assert.match(prompt, /notion\.safe_ops/);
  assert.match(prompt, /Notion は読取、ページ作成、既存ページへの追記だけ許可/);
  assert.match(prompt, /削除、archive、trash、move、duplicate、内容消去/);
  assert.match(prompt, /payload\.message\.web_targets/);
  assert.match(prompt, /公開投稿、予約投稿/);
  assert.match(prompt, /不足情報を1つ/);
  assert.match(prompt, /payload\.context\.recent_messages/);
  assert.match(prompt, /payload\.context\.conversation/);
  assert.match(prompt, /author_is_bot=true/);
  assert.match(prompt, /context_source に discord_url または reply_reference/);
});

test("direct agent text output becomes a safe Discord reply", () => {
  const response = parseDirectAgentResponse(JSON.stringify({
    payloads: [
      {
        text: [
          "Notionに追記しました。",
          "対象: Page abc123",
          "参考 https://example.com/raw @everyone token=secret-value",
        ].join("\n"),
      },
    ],
  }));

  assert.equal(response.action, "reply");
  assert.match(response.body, /Notionに追記しました/);
  assert.match(response.body, /\[link\]/);
  assert.doesNotMatch(response.body, /https?:\/\//);
  assert.doesNotMatch(response.body, /@everyone/);
  assert.doesNotMatch(response.body, /secret-value/);
});

test("direct agent JSON output keeps n8n workflow requests for server-side dispatch", () => {
  const response = parseDirectAgentResponse(JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          body: "n8n workflow に渡します。",
          n8n_workflow_requests: [
            {
              id: "append_1",
              workflow_key: "notion.safe_ops",
              operation: "notion.append_blocks",
              target: { url: "https://www.notion.so/Page-0123456789abcdef0123456789abcdef" },
              input: { body: "追記本文" },
            },
            {
              id: "bad",
              workflow_key: "notion.safe_ops",
              operation: "notion.archive_page",
            },
          ],
        }),
      },
    ],
  }));

  assert.equal(response.action, "reply");
  assert.equal(response.n8n_workflow_requests.length, 1);
  assert.equal(response.n8n_workflow_requests[0].operation, "notion.append_blocks");
  assert.equal(response.n8n_workflow_requests[0].input.body, "追記本文");
});

test("direct reply normalization preserves inline hyphen text while normalizing Discord bullet markers", () => {
  assert.equal(normalizeDirectReplyText("A - B - C"), "A - B - C");
  assert.equal(normalizeDirectReplyText("* A\n• B"), "- A\n- B");
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
    OPENCLAW_N8N_DISPATCH_SECRET: "synthetic-dispatch-secret",
    NOTION_TOKEN: "synthetic-notion-token",
  });

  assert.equal(childEnv.HOME, "/root");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.LANG, "C.UTF-8");
  assert.equal(childEnv.OPENCLAW_API_KEY, undefined);
  assert.equal(childEnv.BOT_TOKEN, undefined);
  assert.equal(childEnv.N8N_WEBHOOK_SECRET, undefined);
  assert.equal(childEnv.OPENCLAW_N8N_DISPATCH_SECRET, undefined);
  assert.equal(childEnv.NOTION_TOKEN, undefined);
});

test("loadConfig defaults to request scoped sessions with fixed compatibility opt-out", () => {
  assert.equal(loadConfig({ OPENCLAW_API_KEY: "secret" }).sessionScope, "request");
  assert.equal(loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_AGENT_SESSION_SCOPE: "fixed",
  }).sessionScope, "fixed");
});

test("loadConfig enables Notion bridge without exposing token to OpenClaw child env", () => {
  const config = loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_NOTION_ENABLED: "true",
    NOTION_TOKEN: "synthetic-notion-token",
    OPENCLAW_NOTION_MAX_RESULTS: "3",
  });

  assert.equal(config.notion.enabled, true);
  assert.equal(config.notion.token, "synthetic-notion-token");
  assert.equal(config.notion.version, "2025-09-03");
  assert.equal(config.notion.maxResults, 3);
  const childEnv = buildOpenClawChildEnv({ NOTION_TOKEN: "synthetic-notion-token", PATH: "/usr/bin" });
  assert.equal(childEnv.NOTION_TOKEN, undefined);
});

test("loadConfig enables n8n dispatch without exposing secret to OpenClaw child env", () => {
  const config = loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_N8N_DISPATCH_ENABLED: "true",
    OPENCLAW_N8N_DISPATCH_URL: "http://n8n:5678/webhook/openclaw/workflow-dispatch",
    OPENCLAW_N8N_DISPATCH_SECRET: "synthetic-dispatch-secret",
    OPENCLAW_N8N_ALLOWED_WORKFLOWS: "notion.safe_ops",
  });

  assert.equal(config.n8nDispatch.enabled, true);
  assert.equal(config.n8nDispatch.url, "http://n8n:5678/webhook/openclaw/workflow-dispatch");
  assert.deepEqual(config.n8nDispatch.allowedWorkflows, ["notion.safe_ops"]);
  const childEnv = buildOpenClawChildEnv({ OPENCLAW_N8N_DISPATCH_SECRET: "secret", PATH: "/usr/bin" });
  assert.equal(childEnv.OPENCLAW_N8N_DISPATCH_SECRET, undefined);
});

test("n8n dispatcher sends only safe metadata and redacts unsafe failure reasons", async () => {
  const request = {
    id: "append_1",
    workflow_key: "notion.safe_ops",
    operation: "notion.append_blocks",
    target: { url: "https://www.notion.so/Page-0123456789abcdef0123456789abcdef" },
    input: { body: "追記本文" },
  };
  const payload = {
    request_id: "req_dispatch",
    guild_id: "guild_1",
    channel: { id: "channel_1", type: "project", thread_id: "thread_1" },
    message: { id: "msg_1", author_id: "user_1", content: "raw token=secret-value" },
    context: {
      notion: {
        links: ["https://www.notion.so/Page-0123456789abcdef0123456789abcdef"],
        explicit_write_requested: true,
        target_provided: true,
      },
    },
  };
  const dispatchPayload = buildDispatchPayload({ payload, request });
  assert.equal(dispatchPayload.discord.message_id, "msg_1");
  assert.equal(dispatchPayload.discord.author_id, "user_1");
  assert.equal(dispatchPayload.message, undefined);
  assert.doesNotMatch(JSON.stringify(dispatchPayload), /raw token=secret-value/);

  const dispatcher = createN8nDispatcher({
    config: {
      n8nDispatch: {
        enabled: true,
        url: "http://n8n.local/webhook/openclaw/workflow-dispatch",
        secret: "secret",
        allowedWorkflows: ["notion.safe_ops"],
        timeoutMs: 1000,
      },
    },
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ reason: "token=secret-value failed" }),
    }),
  });
  const result = await dispatcher.run({ payload, request });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /secret-value/);
  assert.doesNotMatch(result.safe_reply, /secret-value/);
});

test("Notion bridge extracts IDs from Notion URLs and denies destructive writes", async () => {
  assert.equal(
    extractNotionId("https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef?pvs=4"),
    "01234567-89ab-cdef-0123-456789abcdef"
  );
  const bridge = createNotionBridge({
    config: {
      notion: {
        enabled: true,
        token: "secret",
        version: "2025-09-03",
        baseUrl: "https://api.notion.com/v1",
        maxResults: 3,
        maxResultChars: 1000,
      },
    },
    fetchImpl: async () => {
      throw new Error("fetch should not be called for denied operation");
    },
    logger: { warn: () => {} },
  });

  assert.deepEqual(
    await bridge.runWrite({
      operation: "delete_page",
      target: { id: "0123456789abcdef0123456789abcdef" },
    }),
    { ok: false, operation: "delete_page", reason: "notion_write_operation_denied" }
  );
  assert.deepEqual(
    await bridge.runWrite({
      operation: "append_blocks",
      target: { id: "0123456789abcdef0123456789abcdef" },
      archived: true,
      body: "unsafe",
    }),
    { ok: false, operation: "append_blocks", reason: "notion_destructive_write_denied" }
  );
});

test("Notion bridge performs search and append through server-side fetch", async () => {
  const calls = [];
  const bridge = createNotionBridge({
    config: {
      notion: {
        enabled: true,
        token: "secret",
        version: "2025-09-03",
        baseUrl: "https://api.notion.com/v1",
        maxResults: 3,
        maxResultChars: 2000,
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => JSON.stringify(url.endsWith("/search")
          ? { object: "list", results: [{ object: "page", id: "page_1", url: "https://www.notion.so/page_1" }] }
          : { id: "block_1" }),
      };
    },
    logger: { warn: () => {} },
  });

  const read = await bridge.runRead({ operation: "search", query: "Vostok", page_size: 10 });
  const write = await bridge.runWrite({
    operation: "append_blocks",
    target: { id: "0123456789abcdef0123456789abcdef" },
    body: "追記本文",
  });

  assert.equal(read.ok, true);
  assert.equal(write.ok, true);
  assert.equal(write.appended_blocks, 1);
  assert.equal(calls[0].url, "https://api.notion.com/v1/search");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  assert.equal(calls[1].options.method, "PATCH");
});

test("Notion bridge sanitizes large results without breaking JSON structure", async () => {
  const bridge = createNotionBridge({
    config: {
      notion: {
        enabled: true,
        token: "secret",
        version: "2025-09-03",
        baseUrl: "https://api.notion.com/v1",
        maxResults: 3,
        maxResultChars: 800,
      },
    },
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        object: "list",
        results: Array.from({ length: 5 }, (_item, index) => ({
          object: "page",
          id: `page_${index}`,
          url: `https://www.notion.so/page_${index}`,
          properties: { title: { title: [{ plain_text: "x".repeat(2000) }] } },
        })),
      }),
    }),
    logger: { warn: () => {} },
  });

  const read = await bridge.runRead({ operation: "search", query: "large", page_size: 3 });

  assert.equal(read.ok, true);
  assert.equal(read.result.object, "list");
  assert.equal(Array.isArray(read.result.results), true);
  assert.doesNotThrow(() => JSON.stringify(read.result));
});

test("discord respond runs one Notion read tool round before final reply", async () => {
  const runAgentCommand = async ({ message }) => {
    if (!message.includes("tool_results")) {
      return JSON.stringify({
        content: JSON.stringify({
          schema_version: 1,
          action: "observe",
          notion_requests: [{ id: "notion_search", operation: "search", query: "どこでもない場所" }],
        }),
      });
    }
    return JSON.stringify({
      content: JSON.stringify({
        schema_version: 1,
        action: "reply",
        body: "候補を確認したよ",
      }),
    });
  };
  const notionBridge = {
    enabled: true,
    runRead: async (request) => ({ ok: true, operation: request.operation, result: { results: [{ id: "page_1" }] } }),
    runWrite: async () => {
      throw new Error("write should not run");
    },
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_read",
        channel: { id: "1094907178671939654" },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "候補を確認したよ");
  });
});

test("discord respond direct mode skips Notion bridge and accepts normal text output", async () => {
  const notionBridge = {
    enabled: true,
    runRead: async () => {
      throw new Error("direct mode should not use bridge reads");
    },
    runWrite: async () => {
      throw new Error("direct mode should not use bridge writes");
    },
  };
  const prompts = [];
  const runAgentCommand = async ({ message }) => {
    prompts.push(message);
    assert.match(message, /direct handoff agent/);
    assert.match(message, /n8n_workflow_requests/);
    return JSON.stringify({
      payloads: [
        {
          text: "外部URLを確認しました。\n対象: report",
        },
      ],
    });
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_direct_text",
        execution: { mode: "direct_agent", reason: "web_target" },
        channel: { id: "1465296404455882860", type: "project" },
        context: {
          web: { explicit_requested: true, targets: [] },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.action, "reply");
    assert.equal(body.body, "外部URLを確認しました。\n対象: report");
    assert.equal(prompts.length, 1);
  });
});

test("discord respond direct mode dispatches n8n workflow requests with server-side bridge", async () => {
  const n8nDispatcher = {
    enabled: true,
    run: async ({ request }) => {
      assert.equal(request.workflow_key, "notion.safe_ops");
      assert.equal(request.operation, "notion.append_blocks");
      return {
        ok: true,
        reason: "ok",
        safe_reply: "Notionに追記しました。\n対象: test-page",
        results: [{ id: request.id, operation: request.operation, status: "ok", target_title: "test-page" }],
      };
    },
  };
  const runAgentCommand = async () => JSON.stringify({
    payloads: [
      {
        text: JSON.stringify({
          body: "n8n workflow に渡します。",
          n8n_workflow_requests: [
            {
              id: "append_1",
              workflow_key: "notion.safe_ops",
              operation: "notion.append_blocks",
              target: { url: "https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef" },
              input: { body: "追記本文" },
            },
          ],
        }),
      },
    ],
  });

  await withServer({ runAgentCommand, n8nDispatcher }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_direct_n8n",
        execution: { mode: "direct_agent", reason: "notion_target" },
        channel: { id: "1465296404455882860", type: "project" },
        context: {
          notion: {
            explicit_write_requested: true,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.action, "reply");
    assert.equal(body.body, "Notionに追記しました。\n対象: test-page");
    assert.equal(body.n8n_workflow_results.length, 1);
  });
});

test("discord respond direct mode refuses Notion completion without n8n workflow request", async () => {
  const runAgentCommand = async () => JSON.stringify({
    payloads: [{ text: "Notionに追記しました。\n対象: test-page" }],
  });

  await withServer({ runAgentCommand }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_direct_missing_n8n",
        execution: { mode: "direct_agent", reason: "notion_target" },
        channel: { id: "1465296404455882860", type: "project" },
        context: {
          notion: {
            explicit_write_requested: true,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.action, "reply");
    assert.equal(body.reason, "n8n_workflow_request_missing");
    assert.doesNotMatch(body.body, /追記しました/);
  });
});

test("discord respond direct mode returns safe diagnostics on OpenClaw failure", async () => {
  await withServer({
    runAgentCommand: async () => {
      const error = new Error("raw token=secret-value");
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
        request_id: "req_direct_failure",
        execution: { mode: "direct_agent", reason: "web_target" },
        channel: { id: "840827137451229210", type: "chat" },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.action, "reply");
    assert.equal(body.reason, "OPENCLAW_TIMEOUT");
    assert.match(body.body, /direct mode/);
    assert.doesNotMatch(body.body, /token=secret/);
  });
});

test("discord respond direct mode denies destructive Notion requests before running OpenClaw", async () => {
  await withServer({
    runAgentCommand: async () => {
      throw new Error("direct destructive request should not run OpenClaw");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_direct_delete_denied",
        execution: { mode: "direct_agent", reason: "notion_destructive_refusal" },
        channel: { id: "1465296404455882860", type: "project" },
        context: {
          notion: {
            destructive_request: true,
            explicit_write_requested: false,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.action, "reply");
    assert.equal(body.reason, "notion_destructive_request_denied");
    assert.match(body.body, /削除/);
  });
});

test("discord respond direct mode revalidates forged direct payload boundaries", async () => {
  const runAgentCommand = async () => {
    throw new Error("invalid direct payload should not run OpenClaw");
  };

  await withServer({ runAgentCommand }, async (baseUrl) => {
    const cases = [
      {
        name: "ops channel",
        payload: {
          request_id: "req_direct_ops_forged",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229208", type: "ops" },
        },
        reason: "direct_channel_type_denied",
      },
      {
        name: "web without explicit request",
        payload: {
          request_id: "req_direct_web_without_explicit",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { web_targets: [{ url: "https://example.com/report", hostname: "example.com" }] },
          context: { web: { explicit_requested: false } },
        },
        reason: "direct_web_requires_explicit_request",
      },
      {
        name: "unsafe ipv6 web target",
        payload: {
          request_id: "req_direct_ipv6_web",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { web_targets: [{ url: "http://[::1]/admin", hostname: "[::1]" }] },
          context: { web: { explicit_requested: true } },
        },
        reason: "direct_web_target_denied",
      },
      {
        name: "raw content unsafe url",
        payload: {
          request_id: "req_direct_raw_unsafe_url",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { content: "このURLを見て http://[::1]/admin", web_targets: [] },
          context: { web: { explicit_requested: true } },
        },
        reason: "direct_web_target_denied",
      },
      {
        name: "raw content url without forwarded target",
        payload: {
          request_id: "req_direct_raw_url_mismatch",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { content: "このURLを見て https://example.com/report", web_targets: [] },
          context: { web: { explicit_requested: true } },
        },
        reason: "direct_web_target_mismatch",
      },
      {
        name: "attachment",
        payload: {
          request_id: "req_direct_attachment",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { attachments: [{ id: "attachment_1" }] },
        },
        reason: "direct_input_attachment",
      },
      {
        name: "role mention",
        payload: {
          request_id: "req_direct_role_mention",
          execution: { mode: "direct_agent", reason: "forged" },
          channel: { id: "840827137451229210", type: "chat" },
          message: { content: "<@&123456789012345678> 確認して", role_mentions: [] },
        },
        reason: "direct_input_role_mention",
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`${baseUrl}/discord/respond`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
        body: JSON.stringify(testCase.payload),
      });
      const body = await response.json();
      assert.equal(response.status, 200, testCase.name);
      assert.equal(body.action, "observe", testCase.name);
      assert.equal(body.reason, testCase.reason, testCase.name);
    }
  });
});

test("discord respond denies Notion reads to targets not present in the user payload", async () => {
  const runAgentCommand = async ({ message }) => {
    if (!message.includes("tool_results")) {
      return JSON.stringify({
        content: JSON.stringify({
          schema_version: 1,
          action: "observe",
          notion_requests: [{
            id: "read_mismatch",
            operation: "retrieve_page",
            target: { id: "ffffffffffffffffffffffffffffffff" },
          }],
        }),
      });
    }
    assert.match(message, /notion_read_target_mismatch/);
    return JSON.stringify({
      content: JSON.stringify({
        schema_version: 1,
        action: "reply",
        body: "対象が違うので読みません",
      }),
    });
  };
  const notionBridge = {
    enabled: true,
    runRead: async () => {
      throw new Error("read should not run for mismatched target");
    },
    runWrite: async () => {
      throw new Error("write should not run");
    },
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_read_mismatch",
        channel: { id: "1094907178671939654" },
        context: {
          notion: {
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
            target_provided: true,
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.body, "対象が違うので読みません");
  });
});

test("discord respond executes Notion writes only for explicit write payloads", async () => {
  const runAgentCommand = async () => JSON.stringify({
    content: JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "Notionに追記しました",
      notion_writes: [{
        id: "write_1",
        operation: "append_blocks",
        target: { id: "0123456789abcdef0123456789abcdef" },
        body: "追記本文",
      }],
    }),
  });
  const writeCalls = [];
  const notionBridge = {
    enabled: true,
    runRead: async () => ({ ok: true }),
    runWrite: async (request) => {
      writeCalls.push(request);
      return { ok: true, operation: request.operation };
    },
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_write",
        channel: { id: "1094907178671939654" },
        context: {
          notion: {
            explicit_write_requested: true,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(writeCalls.length, 1);
  });

  writeCalls.length = 0;
  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_write_denied",
        channel: { id: "1094907178671939654" },
        context: { notion: { explicit_write_requested: false } },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "notion_write_requires_explicit_request");
    assert.equal(writeCalls.length, 0);
  });

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_write_no_target",
        channel: { id: "1094907178671939654" },
        context: { notion: { explicit_write_requested: true, target_provided: false } },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.reason, "notion_write_target_required");
    assert.match(body.body, /Notion ページ/);
    assert.equal(writeCalls.length, 0);
  });
});

test("discord respond denies Notion writes to targets not present in the user payload", async () => {
  const runAgentCommand = async () => JSON.stringify({
    content: JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "Notionに追記しました",
      notion_writes: [{
        id: "write_1",
        operation: "append_blocks",
        target: { id: "ffffffffffffffffffffffffffffffff" },
        body: "追記本文",
      }],
    }),
  });
  const notionBridge = {
    enabled: true,
    runRead: async () => ({ ok: true }),
    runWrite: async () => {
      throw new Error("write should not run for mismatched target");
    },
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_write_mismatch",
        channel: { id: "1094907178671939654" },
        context: {
          notion: {
            explicit_write_requested: true,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "observe");
    assert.equal(body.reason, "notion_write_target_mismatch");
  });
});

test("discord respond overrides destructive Notion requests with a visible denial", async () => {
  const runAgentCommand = async () => JSON.stringify({
    content: JSON.stringify({
      schema_version: 1,
      action: "reply",
      body: "削除しました",
    }),
  });
  const notionBridge = {
    enabled: true,
    runRead: async () => ({ ok: true }),
    runWrite: async () => {
      throw new Error("write should not run for destructive request");
    },
  };

  await withServer({ runAgentCommand, notionBridge }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/discord/respond`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        request_id: "req_notion_delete_denied",
        channel: { id: "1094907178671939654" },
        context: {
          notion: {
            destructive_request: true,
            explicit_write_requested: false,
            target_provided: true,
            links: ["https://www.notion.so/workspace/Page-0123456789abcdef0123456789abcdef"],
          },
        },
      }),
    });
    const body = await response.json();
    assert.equal(body.action, "reply");
    assert.equal(body.reason, "notion_destructive_request_denied");
    assert.match(body.body, /削除/);
  });
});
