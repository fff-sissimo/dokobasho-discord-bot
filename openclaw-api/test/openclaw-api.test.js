"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { loadConfig } = require("../src/config");
const { buildOpenClawArgs, buildOpenClawChildEnv, buildRequestScopedSessionId } = require("../src/openclaw-runner");
const { createServer } = require("../src/server");
const { buildAgentPrompt, buildObserveResponse, normalizeOpenClawResponse, parseAgentResponse } = require("../src/contracts");

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
  assert.match(prompt, /URL 本文やリンク先内容を自動取得・要約・記憶しない/);
  assert.match(prompt, /raw Discord 本文、秘密値、未加工の会話ログは保存・出力しない/);
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
  assert.equal(loadConfig({
    OPENCLAW_API_KEY: "secret",
    OPENCLAW_AGENT_SESSION_SCOPE: "fixed",
  }).sessionScope, "fixed");
});
