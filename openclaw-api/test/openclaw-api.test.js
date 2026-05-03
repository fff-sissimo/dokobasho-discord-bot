"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { buildOpenClawArgs } = require("../src/openclaw-runner");
const { createServer } = require("../src/server");
const { parseAgentResponse } = require("../src/contracts");

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
          requires_approval: false,
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
    assert.deepEqual(body.approval.links, []);
  });
});

test("invalid OpenClaw output becomes observe response", () => {
  const response = parseAgentResponse("not json");
  assert.equal(response.action, "observe");
  assert.equal(response.reason, "unparseable_openclaw_output");
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
