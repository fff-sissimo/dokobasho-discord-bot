const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_CHANNEL_REGISTRY,
  DEFAULT_OPENCLAW_STATE_DIR,
  SAFE_ALLOWED_MENTIONS,
  buildOpenClawPayload,
  createOpenClawClient,
  createOpenClawInteractionHandler,
  createOpenClawMessageHandler,
  createOpenClawRuntimeConfig,
  createOpenClawStateStore,
  loadOpenClawChannelRegistry,
  normalizeFollowupCandidates,
  normalizeRuntimeMode,
  resolveOpenClawApiUrl,
  resolveOpenClawStateDir,
  runOutboundGate,
  validateOpenClawResponse,
} = require("../src/fairy-openclaw-runtime");

describe("fairy OpenClaw runtime", () => {
  const tmpDirs = [];
  const createTmpStateDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fairy-openclaw-state-"));
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("defaults to n8n runtime mode", () => {
    expect(normalizeRuntimeMode()).toBe("n8n");
    expect(normalizeRuntimeMode("invalid")).toBe("n8n");
    expect(normalizeRuntimeMode("openclaw")).toBe("openclaw");
  });

  it("requires OpenClaw config only in openclaw mode", () => {
    expect(createOpenClawRuntimeConfig({})).toEqual({ mode: "n8n" });
    expect(() =>
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
      })
    ).toThrow("FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS");
  });

  it("uses OPENCLAW_API_BASE_URL with OPENCLAW_API_URL as a legacy alias", () => {
    expect(resolveOpenClawApiUrl({ OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond" }))
      .toBe("https://openclaw.example/discord/respond");
    expect(resolveOpenClawApiUrl({ OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond/" }))
      .toBe("https://openclaw.example/discord/respond/");
    expect(resolveOpenClawApiUrl({ OPENCLAW_API_URL: "https://openclaw.example/discord/respond" }))
      .toBe("https://openclaw.example/discord/respond");
    expect(
      resolveOpenClawApiUrl({
        OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_URL: "https://openclaw.example/discord/respond",
      })
    ).toBe("https://openclaw.example/discord/respond");
    expect(() =>
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "https://openclaw.example/base",
        OPENCLAW_API_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
      })
    ).toThrow("OPENCLAW_API_BASE_URL and OPENCLAW_API_URL differ");
    expect(() =>
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "http://openclaw-api:8788",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
      })
    ).toThrow("OPENCLAW_API_BASE_URL must end with /discord/respond");
  });

  it("uses runtime volume state dir by default and allows absolute FAIRY_OPENCLAW_STATE_DIR override", () => {
    expect(
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
      }).stateDir
    ).toBe(DEFAULT_OPENCLAW_STATE_DIR);

    expect(
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
        FAIRY_OPENCLAW_STATE_DIR: "/tmp/fairy-state-test",
      }).stateDir
    ).toBe("/tmp/fairy-state-test");
  });

  it("rejects dangerous FAIRY_OPENCLAW_STATE_DIR paths", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const discordBotRepo = path.resolve(__dirname, "..");
    const fairyMemoryDir = path.resolve(repoRoot, "..", "dokobasho-fairy-openclaw", "memory");
    const baseOpenClawEnv = {
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
      FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
    };

    expect(() => resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: "relative/state" })).toThrow(
      "absolute path required"
    );
    expect(() =>
      createOpenClawRuntimeConfig({ ...baseOpenClawEnv, FAIRY_OPENCLAW_STATE_DIR: "relative/state" })
    ).toThrow("absolute path required");
    expect(() => resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: "   " })).toThrow("absolute path required");
    expect(() => resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: path.join(repoRoot, "runtime-state") })).toThrow(
      "outside git-tracked runtime paths"
    );
    expect(() =>
      resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: path.join(discordBotRepo, "runtime-state") })
    ).toThrow("outside git-tracked runtime paths");
    expect(() => resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: path.join(fairyMemoryDir, "state") })).toThrow(
      "outside git-tracked runtime paths"
    );
  });

  it("allows default and absolute tmp OpenClaw state dirs", () => {
    const tmpStateDir = path.join(os.tmpdir(), "fairy-openclaw-state-allowed");

    expect(resolveOpenClawStateDir({})).toBe(DEFAULT_OPENCLAW_STATE_DIR);
    expect(resolveOpenClawStateDir({ FAIRY_OPENCLAW_STATE_DIR: `${tmpStateDir}/../fairy-openclaw-state-allowed` }))
      .toBe(tmpStateDir);
  });

  it("builds minimal OpenClaw payload for verified sandbox channel", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      message: {
        id: "msg_1",
        author: { id: "user_1", username: "user" },
        channel: { id: "1094907178671939654", name: "妖精さんより" },
        createdAt: new Date("2026-05-03T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "  相談したいです  ",
      mentionsBot: true,
      allowedChannelIds,
      contextEntries: [
        {
          message_id: "ctx_1",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "前の文脈",
          created_at: "2026-05-03T09:45:00.000Z",
        },
        {
          message_id: "ctx_2",
          author_user_id: "bot_1",
          author_is_bot: true,
          content: "bot文脈",
          created_at: "2026-05-03T09:50:00.000Z",
        },
      ],
    });

    expect(payload.schema_version).toBe(1);
    expect(payload.source).toBe("discord");
    expect(payload.channel).toEqual({
      id: "1094907178671939654",
      name: "妖精さんより",
      type: "sandbox",
      registered: true,
      thread_id: "",
      parent_channel_id: "",
      category_id: "",
    });
    expect(payload.message.content).toBe("相談したいです");
    expect(payload.context.recent_messages).toEqual([
      {
        message_id: "ctx_1",
        author_id: "user_1",
        content: "前の文脈",
        created_at: "2026-05-03T09:45:00.000Z",
      },
    ]);
    expect(payload.context.active_thread_age_minutes).toBe(15);
    expect(payload.context.has_promised_followup).toBe(false);
    expect(payload.context.matched_followup_ids).toEqual([]);
  });

  it("uses the v1 channel registry for phase2 chat payloads", () => {
    const allowedChannelIds = new Set(["1094907178671939654", "840827137451229210"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "840827137451229210", name: "はじまりの酒場" },
      message: {
        id: "msg_chat",
        author: { id: "user_1", username: "user" },
        channel: { id: "840827137451229210", name: "はじまりの酒場" },
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "雑談です",
      allowedChannelIds,
    });

    expect(DEFAULT_CHANNEL_REGISTRY["840827137451229210"].type).toBe("chat");
    expect(payload.channel).toEqual({
      id: "840827137451229210",
      name: "はじまりの酒場",
      type: "chat",
      registered: true,
      thread_id: "",
      parent_channel_id: "",
      category_id: "",
    });
  });

  it("rejects allowlisted channels unless they are verified registry entries", () => {
    const baseEnv = {
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
    };

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "999999999999999999",
      })
    ).toThrow("999999999999999999");

    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1311647968113332275",
      }).channelRegistry["1311647968113332275"].status
    ).toBe("verified");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "841686630271418429",
      })
    ).toThrow("841686630271418429");
  });

  it("rejects default project and ops allowlist entries until explicitly verified", () => {
    const baseEnv = {
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
    };

    expect(DEFAULT_CHANNEL_REGISTRY["1465296404455882860"].status).toBe("pending");
    expect(DEFAULT_CHANNEL_REGISTRY["840827137451229208"].status).toBe("known");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465296404455882860",
      })
    ).toThrow("1465296404455882860");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,840827137451229208",
      })
    ).toThrow("840827137451229208");

    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465296404455882860",
        FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON:
          '{"1465296404455882860":{"name":"vostok-vol02-general","type":"project","status":"verified"}}',
      }).channelRegistry["1465296404455882860"].status
    ).toBe("verified");
    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465295987236143319",
        FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON:
          '[{"channel_id":"1465295987236143319","name":"vostok-vol02-pd","type":"project","status":"verified"}]',
      }).channelRegistry["1465295987236143319"].status
    ).toBe("verified");
  });

  it("uses the canonical verified idea board registry by default", () => {
    const allowedChannelIds = new Set(["1311647968113332275"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1311647968113332275", name: "アイデアボード" },
      message: {
        id: "msg_board_verified_default",
        author: { id: "user_1", username: "user" },
        channel: { id: "1311647968113332275", name: "アイデアボード" },
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "ボード投稿です",
      allowedChannelIds,
    });

    expect(DEFAULT_CHANNEL_REGISTRY["1311647968113332275"]).toEqual({
      name: "アイデアボード",
      type: "board",
      status: "verified",
    });
    expect(payload.channel).toEqual({
      id: "1311647968113332275",
      name: "アイデアボード",
      type: "board",
      registered: true,
      thread_id: "",
      parent_channel_id: "",
      category_id: "",
    });
  });

  it("sends verified idea board payloads as board type", () => {
    const channelRegistry = loadOpenClawChannelRegistry({
      channelRegistry: {
        "1311647968113332275": { name: "アイデアボード", type: "board", status: "verified" },
      },
    });
    const allowedChannelIds = new Set(["1311647968113332275"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1311647968113332275", name: "アイデアボード" },
      message: {
        id: "msg_board_verified",
        author: { id: "user_1", username: "user" },
        channel: { id: "1311647968113332275", name: "アイデアボード" },
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "ボード投稿です",
      allowedChannelIds,
      channelRegistry,
    });

    expect(payload.channel).toEqual({
      id: "1311647968113332275",
      name: "アイデアボード",
      type: "board",
      registered: true,
      thread_id: "",
      parent_channel_id: "",
      category_id: "",
    });
  });

  it("adds thread, parent channel, and category metadata to thread payloads", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const parentChannel = { id: "1094907178671939654", name: "妖精さんより", parentId: "840827137451229205" };
    const threadChannel = {
      id: "123456789012345678",
      name: "相談スレッド",
      isThread: () => true,
      parentId: "1094907178671939654",
      parent: parentChannel,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      message: {
        id: "msg_thread",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "スレッドからです",
      allowedChannelIds,
    });

    expect(payload.channel).toEqual({
      id: "1094907178671939654",
      name: "相談スレッド",
      type: "sandbox",
      registered: true,
      thread_id: "123456789012345678",
      parent_channel_id: "1094907178671939654",
      category_id: "840827137451229205",
    });
  });

  it("keeps creation type resolvable only through custom verified registry", () => {
    const channelRegistry = loadOpenClawChannelRegistry({
      channelRegistry: {
        "841686630271418429": { name: "らくがきちょう", type: "creation", status: "verified" },
      },
    });
    const allowedChannelIds = new Set(["841686630271418429"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "841686630271418429", name: "らくがきちょう" },
      message: {
        id: "msg_creation",
        author: { id: "user_1", username: "user" },
        channel: { id: "841686630271418429", name: "らくがきちょう" },
        createdAt: new Date("2026-05-04T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "作成メモです",
      allowedChannelIds,
      channelRegistry,
    });

    expect(DEFAULT_CHANNEL_REGISTRY["841686630271418429"].status).toBe("known");
    expect(payload.channel.type).toBe("creation");
    expect(payload.channel.registered).toBe(true);
  });

  it("excludes the current message itself from active thread age calculation", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      message: {
        id: "msg_current",
        author: { id: "user_1", username: "user" },
        channel: { id: "1094907178671939654", name: "妖精さんより" },
        createdAt: new Date("2026-05-03T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "今の投稿",
      allowedChannelIds,
      contextEntries: [
        {
          message_id: "ctx_previous",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "直前の人間投稿",
          created_at: "2026-05-03T09:30:00.000Z",
        },
        {
          message_id: "msg_current",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "今の投稿",
          created_at: "2026-05-03T10:00:00.000Z",
        },
      ],
    });

    expect(payload.context.active_thread_age_minutes).toBe(30);
  });

  it("marks only explicit followup requests as promised followup candidates", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const build = (content) =>
      buildOpenClawPayload({
        eventType: "message_create",
        guildId: "840827137451229205",
        channel: { id: "1094907178671939654", name: "妖精さんより" },
        message: {
          id: "msg_followup",
          author: { id: "user_1", username: "user" },
          channel: { id: "1094907178671939654", name: "妖精さんより" },
          createdAt: new Date("2026-05-03T10:00:00.000Z"),
          mentions: { everyone: false, roles: { map: () => [] } },
          attachments: [],
        },
        content,
        allowedChannelIds,
      }).context.has_promised_followup;

    expect(build("明日10:00にこの確認の続きを思い出したいです")).toBe(true);
    expect(build("あとで声かけてください")).toBe(true);
    expect(build("明日という単語を含む雑談です。約束や確認予定にはしないで、短く返してください。")).toBe(false);
  });

  it("validates OpenClaw followup candidates without keeping raw response noise", () => {
    const response = validateOpenClawResponse({
      schema_version: 1,
      action: "reply",
      body: "承知しました",
      followup_candidates: [
        { summary: "進捗確認", due_at: "2026-05-05T10:00:00.000Z", notes: "軽く確認" },
        {
          summary: "metadata形式",
          due_at: "2026-05-05T11:00:00.000Z",
          kind: "explicit_request",
          basis: "unknown",
          assigneeMemberId: "stale_user",
          sourceFollowupId: "stale_due",
          metadata: {
            kind: "agreed_todo",
            basis: "agreed_in_thread",
            assignee_member_id: "user_2",
            source_followup_id: "due_1",
          },
        },
        {
          summary: "空metadata優先",
          due_at: "2026-05-05T12:00:00.000Z",
          assigneeMemberId: "stale_user",
          sourceFollowupId: "stale_due",
          metadata: {
            assignee_member_id: "",
            source_followup_id: "",
          },
        },
        { summary: "日時なし" },
        "invalid",
      ],
    });

    expect(response.followup_candidates).toEqual([
      {
        summary: "進捗確認",
        due_at: "2026-05-05T10:00:00.000Z",
        notes: "軽く確認",
        kind: "explicit_request",
        basis: "unknown",
        assignee_member_id: "",
        source_followup_id: "",
      },
      {
        summary: "metadata形式",
        due_at: "2026-05-05T11:00:00.000Z",
        notes: "",
        kind: "agreed_todo",
        basis: "agreed_in_thread",
        assignee_member_id: "user_2",
        source_followup_id: "due_1",
      },
      {
        summary: "空metadata優先",
        due_at: "2026-05-05T12:00:00.000Z",
        notes: "",
        kind: "explicit_request",
        basis: "unknown",
        assignee_member_id: "",
        source_followup_id: "",
      },
    ]);
    expect(response.checked_followup_ids).toEqual([]);
    expect(response.closed_followup_ids).toEqual([]);
    expect(normalizeFollowupCandidates(null)).toEqual([]);
  });

  it("does not persist unsafe followup summary or notes", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      idFactory: () => "followup_safe",
      now: () => "2026-05-04T10:00:00.000Z",
    });

    const additions = await stateStore.addFollowupCandidates({
      metadata: {
        channel_id: "1094907178671939654",
        channel_type: "sandbox",
        source_message_id: "source_1",
        requested_by_member_id: "user_1",
        has_promised_followup: true,
      },
      candidates: [
        { summary: "確認 https://example.com/raw", due_at: "2026-05-05T10:00:00.000Z" },
        { summary: "安全な確認", due_at: "2026-05-05T11:00:00.000Z", notes: "token=abc123secret" },
        { summary: "長".repeat(201), due_at: "2026-05-05T12:00:00.000Z" },
      ],
    });

    const state = JSON.parse(await fs.readFile(path.join(stateDir, "followups.json"), "utf8"));
    expect(additions).toHaveLength(1);
    expect(state.followups).toEqual([
      expect.objectContaining({
        summary: "安全な確認",
        notes: "",
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("https://example.com/raw");
    expect(JSON.stringify(state)).not.toContain("token=abc123secret");
    expect(JSON.stringify(state)).not.toContain("長".repeat(201));
  });

  it("normalizes followup state to the persisted whitelist schema", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({ stateDir });

    await stateStore.writeFollowupState({
      followups: [
        {
          id: "followup_whitelist",
          status: "open",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_1",
          requested_by_member_id: "user_1",
          summary: "確認する",
          due_at: "2026-05-05T10:00:00.000Z",
          created_at: "",
          last_checked_at: undefined,
          closed_at: null,
          notes: "短いメモ",
          content: "raw Discord content should be dropped",
          arbitrary_key: "drop me",
        },
      ],
    });

    const state = JSON.parse(await fs.readFile(path.join(stateDir, "followups.json"), "utf8"));
    expect(Object.keys(state.followups[0])).toEqual([
      "id",
      "status",
      "channel_id",
      "channel_type",
      "source_message_id",
      "requested_by_member_id",
      "summary",
      "due_at",
      "kind",
      "basis",
      "assignee_member_id",
      "source_followup_id",
      "created_at",
      "last_checked_at",
      "closed_at",
      "notes",
    ]);
    expect(state.followups[0]).toEqual({
      id: "followup_whitelist",
      status: "open",
      channel_id: "1094907178671939654",
      channel_type: "sandbox",
      source_message_id: "source_1",
      requested_by_member_id: "user_1",
      summary: "確認する",
      due_at: "2026-05-05T10:00:00.000Z",
      kind: "explicit_request",
      basis: "unknown",
      assignee_member_id: "",
      source_followup_id: "",
      created_at: null,
      last_checked_at: null,
      closed_at: null,
      notes: "短いメモ",
    });
    expect(JSON.stringify(state)).not.toContain("raw Discord content should be dropped");
    expect(JSON.stringify(state)).not.toContain("arbitrary_key");
  });

  it("writes heartbeat state with the docs runtime schema only", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({ stateDir });

    await stateStore.writeHeartbeatState({
      last_payload_at: "2026-05-04T10:00:00.000Z",
      last_request_id: "req_raw",
      updated_at: "2026-05-04T10:00:01.000Z",
      lastChecks: {
        server_flow: "",
        memory_maintenance: null,
        followups: "2026-05-04T10:00:00.000Z",
      },
    });

    const state = JSON.parse(await fs.readFile(path.join(stateDir, "heartbeat-state.json"), "utf8"));
    expect(state).toEqual({
      schema_version: 1,
      lastChecks: {
        server_flow: null,
        memory_maintenance: null,
        followups: "2026-05-04T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(state)).not.toContain("last_payload_at");
    expect(JSON.stringify(state)).not.toContain("last_request_id");
    expect(JSON.stringify(state)).not.toContain("updated_at");
  });

  it("saves response followup candidates only for explicit followup context", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      idFactory: () => "followup_1",
      now: () => "2026-05-04T10:00:00.000Z",
    });
    const addFollowupCandidatesSpy = jest.spyOn(stateStore, "addFollowupCandidates");
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "明日確認します",
        requires_approval: false,
        followup_candidates: [
          { summary: "進捗を確認", due_at: "2026-05-05T10:00:00.000Z", notes: "短く聞く" },
        ],
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_followup_save",
    });
    const message = {
      id: "msg_followup_save",
      content: "<@bot_1> 明日10:00に進捗確認して",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_followup_save" }),
    };

    await handler(message, { messageTriggerSource: "mention" });

    expect(addFollowupCandidatesSpy).toHaveBeenCalledWith({
      metadata: {
        channel_id: "1094907178671939654",
        channel_type: "sandbox",
        source_message_id: "msg_followup_save",
        requested_by_member_id: "user_1",
        has_promised_followup: true,
      },
      candidates: [
        {
          summary: "進捗を確認",
          due_at: "2026-05-05T10:00:00.000Z",
          notes: "短く聞く",
          kind: "explicit_request",
          basis: "unknown",
          assignee_member_id: "",
          source_followup_id: "",
        },
      ],
    });
    expect(JSON.stringify(addFollowupCandidatesSpy.mock.calls[0][0])).not.toContain("明日10:00に進捗確認して");
    const state = JSON.parse(await fs.readFile(path.join(stateDir, "followups.json"), "utf8"));
    expect(state.followups).toEqual([
      expect.objectContaining({
        id: "followup_1",
        channel_id: "1094907178671939654",
        channel_type: "sandbox",
        source_message_id: "msg_followup_save",
        requested_by_member_id: "user_1",
        summary: "進捗を確認",
        due_at: "2026-05-05T10:00:00.000Z",
        kind: "explicit_request",
        basis: "unknown",
        assignee_member_id: "",
        source_followup_id: "",
        status: "open",
        notes: "短く聞く",
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("明日10:00に進捗確認して");
    expect(JSON.parse(await fs.readFile(path.join(stateDir, "heartbeat-state.json"), "utf8"))).toEqual({
      schema_version: 1,
      lastChecks: {
        server_flow: null,
        memory_maintenance: null,
        followups: expect.any(String),
      },
    });
    await expect(fs.access(path.join(__dirname, "..", "memory", "followups.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not save followup candidates for casual tomorrow talk", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      idFactory: () => "followup_casual",
      now: () => "2026-05-04T10:00:00.000Z",
    });
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "そうですね",
        requires_approval: false,
        followup_candidates: [{ summary: "雑談候補", due_at: "2026-05-05T10:00:00.000Z" }],
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_followup_casual",
    });
    const message = {
      id: "msg_followup_casual",
      content: "<@bot_1> 明日は晴れるかな",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_followup_casual" }),
    };

    await handler(message, { messageTriggerSource: "mention" });

    await expect(fs.access(path.join(stateDir, "followups.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops risky input before calling OpenClaw or mutating runtime state", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({ stateDir });
    const openClawClient = { execute: jest.fn() };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_risky_input",
    });
    const message = {
      id: "msg_risky_input",
      content: "<@bot_1> https://example.com を見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn() },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_risky_input" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.gate).toEqual({ ok: false, reason: "input_external_link" });
    expect(openClawClient.execute).not.toHaveBeenCalled();
    expect(message.channel.sendTyping).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      content: "-# 今回は自動送信せず止めました。",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    await expect(fs.access(path.join(stateDir, "followups.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(stateDir, "heartbeat-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops slash command role mention text before calling OpenClaw or mutating runtime state", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({ stateDir });
    const openClawClient = { execute: jest.fn() };
    const handler = createOpenClawInteractionHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_slash_risky_input",
    });
    const interaction = {
      id: "interaction_risky_input",
      commandName: "fairy",
      guildId: "840827137451229205",
      channelId: "1094907178671939654",
      user: { id: "user_1", username: "user" },
      member: { displayName: "user" },
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      isChatInputCommand: () => true,
      options: { getString: () => "<@&123456789012345678> に確認して" },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    const result = await handler(interaction);

    expect(result.gate).toEqual({ ok: false, reason: "input_role_mention" });
    expect(openClawClient.execute).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "-# 今回は自動送信せず止めました。",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    await expect(fs.access(path.join(stateDir, "followups.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(stateDir, "heartbeat-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the followup channel-type gate matrix without requiring project assignees", async () => {
    const cases = [
      {
        channel_type: "chat",
        candidate: { summary: "明示依頼", due_at: "2026-05-05T10:00:00.000Z", kind: "explicit_request", basis: "explicit_user_request" },
        allowed: true,
      },
      {
        channel_type: "board",
        candidate: { summary: "正式クエスト", due_at: "2026-05-05T10:00:00.000Z", kind: "formal_quest", basis: "agreed_in_thread" },
        allowed: true,
      },
      {
        channel_type: "project",
        candidate: { summary: "合意済みTODO", due_at: "2026-05-05T10:00:00.000Z", kind: "agreed_todo", basis: "agreed_in_thread" },
        allowed: true,
      },
      {
        channel_type: "ops",
        candidate: { summary: "運用確認", due_at: "2026-05-05T10:00:00.000Z", kind: "explicit_request", basis: "explicit_user_request" },
        allowed: false,
      },
      {
        channel_type: "unknown",
        candidate: { summary: "未登録", due_at: "2026-05-05T10:00:00.000Z", kind: "explicit_request", basis: "explicit_user_request" },
        allowed: false,
      },
    ];

    for (const testCase of cases) {
      const stateDir = await createTmpStateDir();
      const stateStore = createOpenClawStateStore({
        stateDir,
        idFactory: () => `followup_${testCase.channel_type}`,
        now: () => "2026-05-04T10:00:00.000Z",
      });
      const additions = await stateStore.addFollowupCandidates({
        metadata: {
          channel_id: `channel_${testCase.channel_type}`,
          channel_type: testCase.channel_type,
          source_message_id: "source_1",
          requested_by_member_id: "user_1",
          has_promised_followup: true,
        },
        candidates: [testCase.candidate],
      });

      expect(additions).toHaveLength(testCase.allowed ? 1 : 0);
      if (testCase.allowed) {
        expect(additions[0]).toEqual(expect.objectContaining({
          kind: testCase.candidate.kind,
          basis: testCase.candidate.basis,
          assignee_member_id: "",
        }));
      } else {
        await expect(fs.access(path.join(stateDir, "followups.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("adds due open followup ids to the next OpenClaw payload", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      now: () => "2026-05-05T10:30:00.000Z",
    });
    await stateStore.writeFollowupState({
      followups: [
        {
          id: "due_1",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_1",
          requested_by_member_id: "user_1",
          summary: "進捗を確認",
          due_at: "2026-05-03T10:00:00.000Z",
          created_at: "2026-05-04T10:00:00.000Z",
          status: "open",
          last_checked_at: null,
          closed_at: null,
          notes: "",
        },
      ],
    });
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "observe",
        body: "",
        requires_approval: false,
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_due_payload",
    });
    const message = {
      id: "msg_due_payload",
      content: "<@bot_1> 確認ある？",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-05T10:30:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn(),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.payload.context.matched_followup_ids).toEqual(["due_1"]);
    expect(openClawClient.execute.mock.calls[0][0].context.matched_followup_ids).toEqual(["due_1"]);
  });

  it("updates checked and closed followups without storing raw Discord content", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      now: () => "2026-05-05T10:30:00.000Z",
    });
    await stateStore.writeFollowupState({
      followups: [
        {
          id: "due_1",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_1",
          requested_by_member_id: "user_1",
          summary: "進捗を確認",
          due_at: "2026-05-05T10:00:00.000Z",
          created_at: "2026-05-04T10:00:00.000Z",
          status: "open",
          last_checked_at: null,
          closed_at: null,
          notes: "",
        },
      ],
    });

    const checked = await stateStore.markFollowupsChecked("due_1", {
      checkedAt: "2026-05-05T10:31:00.000Z",
      notes: "確認済み",
    });
    const closed = await stateStore.closeFollowups("due_1", {
      closedAt: "2026-05-05T10:40:00.000Z",
      notes: "不要になった",
    });

    const state = await stateStore.readFollowupState();
    expect(checked[0]).toEqual(expect.objectContaining({ status: "checked" }));
    expect(closed[0]).toEqual(expect.objectContaining({ status: "closed" }));
    expect(state.followups[0]).toEqual(
      expect.objectContaining({
        status: "closed",
        last_checked_at: "2026-05-05T10:31:00.000Z",
        closed_at: "2026-05-05T10:40:00.000Z",
        notes: "不要になった",
      })
    );
    expect(JSON.stringify(state)).not.toContain("Discord raw");
  });

  it("applies checked and closed followup ids from OpenClaw response", async () => {
    const stateDir = await createTmpStateDir();
    const stateStore = createOpenClawStateStore({
      stateDir,
      now: () => "2026-05-05T10:30:00.000Z",
    });
    await stateStore.writeFollowupState({
      followups: [
        {
          id: "checked_1",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_checked",
          requested_by_member_id: "user_1",
          summary: "確認する",
          due_at: "2026-05-05T10:00:00.000Z",
          created_at: "2026-05-04T10:00:00.000Z",
          status: "open",
          last_checked_at: null,
          closed_at: null,
          notes: "",
        },
        {
          id: "closed_1",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_closed",
          requested_by_member_id: "user_1",
          summary: "閉じる",
          due_at: "2026-05-05T10:00:00.000Z",
          created_at: "2026-05-04T10:00:00.000Z",
          status: "open",
          last_checked_at: null,
          closed_at: null,
          notes: "",
        },
      ],
    });
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "observe",
        body: "",
        requires_approval: false,
        checked_followup_ids: ["checked_1"],
        closed_followup_ids: ["closed_1"],
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      stateStore,
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_followup_transition",
    });
    const message = {
      id: "msg_followup_transition",
      content: "<@bot_1> 確認したよ",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-05T10:30:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn(),
    };

    await handler(message, { messageTriggerSource: "mention" });

    const state = await stateStore.readFollowupState();
    expect(state.followups).toEqual([
      expect.objectContaining({
        id: "checked_1",
        status: "checked",
        last_checked_at: "2026-05-05T10:30:00.000Z",
        closed_at: null,
      }),
      expect.objectContaining({
        id: "closed_1",
        status: "closed",
        last_checked_at: null,
        closed_at: "2026-05-05T10:30:00.000Z",
      }),
    ]);
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("posts OpenClaw response with empty allowed mentions", async () => {
    const sendTyping = jest.fn().mockResolvedValue(undefined);
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "確認しました",
        requires_approval: false,
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_1",
    });
    const message = {
      id: "msg_1",
      content: "<@bot_1> 見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_1" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.gate).toEqual({ ok: true, reason: "ok" });
    expect(result.replyMessageId).toBe("reply_1");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith({
      content: "確認しました",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
  });

  it("replies with a gate stop notice for visible message-trigger gates", async () => {
    const cases = [
      {
        name: "external link",
        response: { schema_version: 1, action: "reply", body: "see https://example.com", requires_approval: false },
        reason: "external_link",
      },
      {
        name: "everyone mention",
        response: { schema_version: 1, action: "reply", body: "hi @everyone", requires_approval: false },
        reason: "blocked_mention",
      },
      {
        name: "requires approval",
        response: { schema_version: 1, action: "reply", body: "承認待ち", requires_approval: true },
        reason: "requires_approval",
      },
      {
        name: "approval side effect",
        response: {
          schema_version: 1,
          action: "reply",
          body: "添付します",
          requires_approval: false,
          approval: { attachments: ["file_1"] },
        },
        reason: "approval_side_effect",
      },
      {
        name: "draft",
        response: { schema_version: 1, action: "draft", body: "下書きです", requires_approval: false },
        reason: "non_posting_action:draft",
      },
      {
        name: "publish blocked",
        response: { schema_version: 1, action: "publish_blocked", body: "公開停止", requires_approval: false },
        reason: "non_posting_action:publish_blocked",
      },
    ];

    for (const testCase of cases) {
      const openClawClient = {
        execute: jest.fn().mockResolvedValue(testCase.response),
      };
      const handler = createOpenClawMessageHandler({
        openClawClient,
        allowedChannelIds: ["1094907178671939654"],
        guildId: "840827137451229205",
        contextEntriesSource: async () => [],
        requestIdFactory: () => `req_${testCase.name}`,
      });
      const message = {
        id: `msg_${testCase.name}`,
        content: "<@bot_1> 見て",
        channelId: "1094907178671939654",
        guildId: "840827137451229205",
        createdAt: new Date("2026-05-03T10:00:00.000Z"),
        author: { id: "user_1", bot: false, username: "user" },
        client: { user: { id: "bot_1" } },
        channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
        reply: jest.fn().mockResolvedValue({ id: `reply_${testCase.name}` }),
      };

      const result = await handler(message, { messageTriggerSource: "mention" });

      expect(result.gate.reason).toBe(testCase.reason);
      expect(result.replyMessageId).toBe(`reply_${testCase.name}`);
      expect(message.reply).toHaveBeenCalledWith({
        content: "-# 今回は自動送信せず止めました。",
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
    }
  });

  it("does not reply for observe action on message trigger", async () => {
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "observe",
        body: "",
        requires_approval: false,
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_observe",
    });
    const message = {
      id: "msg_observe",
      content: "<@bot_1> 見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn(),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.gate.reason).toBe("non_posting_action:observe");
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("does not call OpenClaw or reply outside verified channels", async () => {
    const openClawClient = { execute: jest.fn() };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
    });
    const message = {
      id: "msg_2",
      content: "<@bot_1> 見て",
      channelId: "840827137451229210",
      guildId: "840827137451229205",
      author: { id: "user_1", bot: false },
      client: { user: { id: "bot_1" } },
      reply: jest.fn(),
    };

    const result = await handler(message);

    expect(result.handled).toBe(false);
    expect(result.gate.reason).toBe("channel_not_verified");
    expect(openClawClient.execute).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("keeps typing while waiting for OpenClaw and stops after replying", async () => {
    jest.useFakeTimers();
    const sendTyping = jest.fn().mockResolvedValue(undefined);
    let resolveExecute;
    const openClawClient = {
      execute: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveExecute = resolve;
          })
      ),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_typing",
    });
    const message = {
      id: "msg_typing",
      content: "<@bot_1> 待っている間の表示を確認",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_typing" }),
    };

    const handled = handler(message, { messageTriggerSource: "mention" });
    await Promise.resolve();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(7500);
    await Promise.resolve();
    expect(sendTyping).toHaveBeenCalledTimes(2);

    resolveExecute({
      schema_version: 1,
      action: "reply",
      body: "確認しました",
      requires_approval: false,
    });
    await handled;
    jest.advanceTimersByTime(15000);
    await Promise.resolve();

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(message.reply).toHaveBeenCalledWith({
      content: "確認しました",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
  });

  it("continues OpenClaw reply when typing indicator fails", async () => {
    const sendTyping = jest.fn().mockRejectedValue(new Error("missing permission"));
    const logger = { warn: jest.fn() };
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "入力中表示に失敗しても返答します",
        requires_approval: false,
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_typing_failure",
      logger,
    });
    const message = {
      id: "msg_typing_failure",
      content: "<@bot_1> 見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_typing_failure" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });
    await Promise.resolve();

    expect(result.handled).toBe(true);
    expect(result.replyMessageId).toBe("reply_typing_failure");
    expect(openClawClient.execute).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith({
      content: "入力中表示に失敗しても返答します",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
  });

  it("blocks mentions, links, approval-required responses, and non-posting actions", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const channelId = "1094907178671939654";

    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "hi @everyone" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("blocked_mention");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "see https://example.com" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("external_link");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "token=synthetic-secret-value" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("secret_like_output");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "Authorization: Bearer syntheticBearer12345" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("secret_like_output");
    for (const body of [
      "Authorization:Bearer syntheticBearer12345",
      "Authorization:Basic c3ludGhldGljMTIzNDU=",
    ]) {
      expect(
        runOutboundGate({
          response: validateOpenClawResponse({ action: "reply", body }),
          channelId,
          allowedChannelIds,
        }).reason
      ).toBe("secret_like_output");
    }
    for (const body of [
      "OPENCLAW_API_KEY=syntheticSecret12345",
      "DISCORD_BOT_TOKEN=syntheticSecret12345",
      "N8N_WEBHOOK_SECRET=syntheticSecret12345",
      "OPENAI_API_KEY=\"syntheticSecret12345\"",
      "BOT_TOKEN='syntheticSecret12345'",
      "N8N_WEBHOOK_SECRET: \"syntheticSecret12345\"",
    ]) {
      expect(
        runOutboundGate({
          response: validateOpenClawResponse({ action: "reply", body }),
          channelId,
          allowedChannelIds,
        }).reason
      ).toBe("secret_like_output");
    }
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "承認待ち", requires_approval: true }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("requires_approval");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "observe", body: "" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("non_posting_action:observe");
  });

  it("blocks role mentions in output and input risk regardless of OpenClaw response", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const channelId = "1094907178671939654";

    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "hi <@&123456789012345678>" }),
        channelId,
        allowedChannelIds,
      }).reason
    ).toBe("blocked_mention");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId,
        allowedChannelIds,
        payload: { message: { role_mentions: ["123456789012345678"], attachments: [], links: [] }, channel: { type: "sandbox" } },
      }).reason
    ).toBe("input_role_mention");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId,
        allowedChannelIds,
        payload: { message: { mentions_everyone: true, role_mentions: [], attachments: [], links: [] }, channel: { type: "sandbox" } },
      }).reason
    ).toBe("input_everyone_or_here");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId,
        allowedChannelIds,
        payload: { message: { role_mentions: [], attachments: [{ id: "file_1" }], links: [] }, channel: { type: "sandbox" } },
      }).reason
    ).toBe("input_attachment");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId,
        allowedChannelIds,
        payload: { message: { role_mentions: [], attachments: [], links: ["https://example.com"] }, channel: { type: "sandbox" } },
      }).reason
    ).toBe("input_external_link");
  });

  it("keeps ops channels draft-only even when registry override verifies them", () => {
    const allowedChannelIds = new Set(["840827137451229208"]);
    const response = validateOpenClawResponse({ action: "reply", body: "確認しました" });

    expect(
      runOutboundGate({
        response,
        channelId: "840827137451229208",
        allowedChannelIds,
        channelMetadata: { type: "ops" },
      })
    ).toEqual({ ok: false, reason: "ops_draft_only" });
  });

  it("sends OpenClaw request with bearer auth", async () => {
    const json = jest.fn().mockResolvedValue({ action: "observe", body: "" });
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json });
    const client = createOpenClawClient({
      apiUrl: "https://openclaw.example/discord/respond",
      apiKey: "secret",
      fetchImpl,
      timeoutMs: 100,
    });

    await client.execute({ schema_version: 1 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openclaw.example/discord/respond",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
      })
    );
  });
});
