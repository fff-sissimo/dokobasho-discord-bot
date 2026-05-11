const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createSchedulerOpenClawEventsConfig,
  createSchedulerOpenClawEventsRunner,
  deriveAutonomyUrl,
} = require("../src/scheduler-openclaw-events");

const baseEnv = (stateDir) => ({
  FAIRY_RUNTIME_MODE: "openclaw",
  OPENCLAW_API_BASE_URL: "http://openclaw-api:8788/discord/respond",
  OPENCLAW_API_KEY: "test-openclaw-key",
  FAIRY_OPENCLAW_STATE_DIR: stateDir,
  DEFAULT_TZ: "Asia/Tokyo",
});

describe("scheduler OpenClaw autonomy events", () => {
  const tmpDirs = [];
  const createTmpStateDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-openclaw-events-"));
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("is disabled when OpenClaw scheduler env is unset", () => {
    const config = createSchedulerOpenClawEventsConfig({});
    expect(config.enabled).toBe(false);

    const fetchImpl = jest.fn();
    const runner = createSchedulerOpenClawEventsRunner({ env: {}, fetchImpl });
    expect(runner.config.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("derives internal autonomy URLs from /discord/respond", () => {
    const stateDir = path.join(os.tmpdir(), "scheduler-openclaw-events-config");
    const config = createSchedulerOpenClawEventsConfig({
      ...baseEnv(stateDir),
      OPENCLAW_REQUEST_AUDIT_PATH: "/var/lib/dokobasho/fairy-openclaw-state/request-audit.jsonl",
    });
    expect(config.hasApiKey).toBe(true);
    expect(config.apiKey).toBeUndefined();
    expect(config.requestAuditPath).toBe("/var/lib/dokobasho/fairy-openclaw-state/request-audit.jsonl");
    expect(deriveAutonomyUrl("http://openclaw-api:8788/discord/respond", "heartbeat"))
      .toBe("http://openclaw-api:8788/internal/autonomy/heartbeat");
    expect(deriveAutonomyUrl("http://openclaw-api:8788/discord/respond", "dreaming"))
      .toBe("http://openclaw-api:8788/internal/autonomy/dreaming");
  });

  it("accepts legacy OPENCLAW_API_URL for scheduler autonomy config", () => {
    const stateDir = path.join(os.tmpdir(), "scheduler-openclaw-events-legacy-config");
    const config = createSchedulerOpenClawEventsConfig({
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_URL: "http://openclaw-api:8788/discord/respond",
      OPENCLAW_API_KEY: "test-openclaw-key",
      FAIRY_OPENCLAW_STATE_DIR: stateDir,
    });

    expect(config.enabled).toBe(true);
    expect(config.heartbeatUrl).toBe("http://openclaw-api:8788/internal/autonomy/heartbeat");
  });

  it("does not fetch heartbeat when no followup is due and records no_op audit", async () => {
    const stateDir = await createTmpStateDir();
    const fetchImpl = jest.fn();
    const runner = createSchedulerOpenClawEventsRunner({
      env: baseEnv(stateDir),
      fetchImpl,
      now: () => "2026-05-12T03:00:00.000Z",
    });

    const result = await runner.runHeartbeat();

    expect(result).toEqual({ status: "no_op", dueFollowupCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const heartbeatState = JSON.parse(await fs.readFile(path.join(stateDir, "heartbeat-state.json"), "utf8"));
    expect(heartbeatState.lastChecks.followups).toBe("2026-05-12T03:00:00.000Z");
    const audit = await fs.readFile(path.join(stateDir, "autonomy-audit.jsonl"), "utf8");
    expect(audit).toContain('"status":"no_op"');
  });

  it("fetches heartbeat with Bearer auth and safe due followups only", async () => {
    const stateDir = await createTmpStateDir();
    await fs.writeFile(path.join(stateDir, "followups.json"), JSON.stringify({
      schema_version: 1,
      followups: [
        {
          id: "due_1",
          status: "open",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "msg_raw_should_not_send",
          requested_by_member_id: "user_raw_should_not_send",
          summary: "安全な確認だけ",
          due_at: "2026-05-12T02:59:00.000Z",
          kind: "test_only",
          basis: "explicit_user_request",
          assignee_member_id: "",
          source_followup_id: "",
          created_at: "2026-05-12T02:00:00.000Z",
          last_checked_at: null,
          closed_at: null,
          notes: "raw note should not send",
        },
        {
          id: "future_1",
          status: "open",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          summary: "未来の確認",
          due_at: "2026-05-13T02:59:00.000Z",
          kind: "test_only",
          basis: "explicit_user_request",
          assignee_member_id: "",
          source_followup_id: "",
          created_at: "2026-05-12T02:00:00.000Z",
          last_checked_at: null,
          closed_at: null,
          notes: "",
        },
      ],
    }), "utf8");
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ action: "mark_checked", checked_followup_ids: ["due_1", "future_1"] }),
    }));
    const runner = createSchedulerOpenClawEventsRunner({
      env: baseEnv(stateDir),
      fetchImpl,
      now: () => "2026-05-12T03:00:00.000Z",
    });

    const result = await runner.runHeartbeat();

    expect(result.status).toBe("sent");
    expect(result.checkedCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://openclaw-api:8788/internal/autonomy/heartbeat");
    expect(options.headers.authorization).toBe("Bearer test-openclaw-key");
    const payload = JSON.parse(options.body);
    expect(payload.followups).toEqual([
      {
        id: "due_1",
        summary: "安全な確認だけ",
        channel: { id: "1094907178671939654", type: "sandbox" },
        kind: "test_only",
        due_at: "2026-05-12T02:59:00.000Z",
      },
    ]);
    expect(options.body).not.toContain("msg_raw_should_not_send");
    expect(options.body).not.toContain("raw note should not send");
    const state = JSON.parse(await fs.readFile(path.join(stateDir, "followups.json"), "utf8"));
    expect(state.followups[0].status).toBe("checked");
    expect(state.followups[0].last_checked_at).toBe("2026-05-12T03:00:00.000Z");
    expect(state.followups[1].status).toBe("open");
  });

  it("stores dreaming response without raw Discord content", async () => {
    const stateDir = await createTmpStateDir();
    await fs.writeFile(path.join(stateDir, "followups.json"), JSON.stringify({
      schema_version: 1,
      followups: [
        {
          id: "open_1",
          status: "open",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          summary: "安全な確認だけ",
          due_at: "2026-05-12T02:59:00.000Z",
          kind: "test_only",
          basis: "explicit_user_request",
          created_at: "2026-05-12T02:00:00.000Z",
        },
      ],
    }), "utf8");
    await fs.writeFile(path.join(stateDir, "request-audit.jsonl"), [
      JSON.stringify({
        action: "reply",
        channel_type: "sandbox",
        execution_mode: "direct_agent",
        status: "ok",
        raw_discord_body: "RAW DISCORD BODY MUST NOT BE SAVED",
      }),
      JSON.stringify({
        action: "sk-proj-secret-must-not-survive",
        channel_type: "token=secret-value",
        execution_mode: "direct_agent",
        status: "ok",
        error_code: "Bearer abcdefghijklmnopqrstuvwxyz",
      }),
      "",
    ].join("\n"), "utf8");
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        dream: "safe dream summary",
        risk_note: "token=secret-value",
        other_note: "Bearer abcdefghijklmnopqrstuvwxyz",
        raw_discord_body: "RAW DISCORD BODY MUST NOT BE SAVED",
        nested: { content: "RAW nested content MUST NOT BE SAVED", safe_count: 1 },
      }),
    }));
    const runner = createSchedulerOpenClawEventsRunner({
      env: baseEnv(stateDir),
      fetchImpl,
      now: () => "2026-05-12T03:00:00.000Z",
    });

    const result = await runner.runDreaming();

    expect(result.status).toBe("saved");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://openclaw-api:8788/internal/autonomy/dreaming");
    expect(options.headers.authorization).toBe("Bearer test-openclaw-key");
    expect(options.body).not.toContain("RAW DISCORD BODY MUST NOT BE SAVED");
    expect(options.body).not.toContain("sk-proj-secret-must-not-survive");
    expect(options.body).not.toContain("token=secret-value");
    expect(options.body).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const dreamFile = await fs.readFile(path.join(stateDir, "dreams", "2026-05-12.json"), "utf8");
    expect(dreamFile).toContain("safe dream summary");
    expect(dreamFile).not.toContain("RAW DISCORD BODY MUST NOT BE SAVED");
    expect(dreamFile).not.toContain("sk-proj-secret-must-not-survive");
    expect(dreamFile).not.toContain("RAW nested content MUST NOT BE SAVED");
    expect(dreamFile).not.toContain("secret-value");
    expect(dreamFile).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("skips overlapping heartbeat runs with in-flight lock", async () => {
    const stateDir = await createTmpStateDir();
    await fs.writeFile(path.join(stateDir, "followups.json"), JSON.stringify({
      schema_version: 1,
      followups: [
        {
          id: "due_1",
          status: "open",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          summary: "安全な確認だけ",
          due_at: "2026-05-12T02:59:00.000Z",
          kind: "test_only",
          basis: "explicit_user_request",
          created_at: "2026-05-12T02:00:00.000Z",
        },
      ],
    }), "utf8");
    let resolveFetch;
    const fetchImpl = jest.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const runner = createSchedulerOpenClawEventsRunner({
      env: baseEnv(stateDir),
      fetchImpl,
      now: () => "2026-05-12T03:00:00.000Z",
    });

    const firstRun = runner.runHeartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    const secondRun = await runner.runHeartbeat();
    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
    const firstResult = await firstRun;

    expect(secondRun).toEqual({ skipped: true, reason: "in_flight" });
    expect(firstResult.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
