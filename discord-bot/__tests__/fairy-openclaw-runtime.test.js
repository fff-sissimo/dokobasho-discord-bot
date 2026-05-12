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

  it("allows OpenClaw config with verified category ids only", () => {
    const config = createOpenClawRuntimeConfig({
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
      FAIRY_OPENCLAW_ALLOWED_CATEGORY_IDS: "1201092282254893066,1098535279549235280",
    });

    expect(config.allowedChannelIds).toEqual([]);
    expect(config.allowedCategoryIds).toEqual(["1201092282254893066", "1098535279549235280"]);

    expect(() =>
      createOpenClawRuntimeConfig({
        FAIRY_RUNTIME_MODE: "openclaw",
        OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CATEGORY_IDS: "865619584282918982",
      })
    ).toThrow("865619584282918982");
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
        OPENCLAW_API_BASE_URL: "https://openclaw-a.example/discord/respond",
        OPENCLAW_API_URL: "https://openclaw-b.example/discord/respond",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
      })
    ).toThrow("OPENCLAW_API_BASE_URL and OPENCLAW_API_URL differ");
    expect(() =>
      resolveOpenClawApiUrl({ OPENCLAW_API_BASE_URL: "http://openclaw-api:8788" })
    ).toThrow("/discord/respond");
  });

  it("uses runtime volume state dir by default and allows absolute FAIRY_OPENCLAW_STATE_DIR override", () => {
    const defaultConfig = createOpenClawRuntimeConfig({
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
      FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654",
    });
    expect(defaultConfig.stateDir).toBe(DEFAULT_OPENCLAW_STATE_DIR);
    expect(defaultConfig.timeoutMs).toBe(180000);

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
        author_display_name: "",
        author_is_bot: false,
        channel_id: "",
        thread_id: "",
        reply_to_message_id: "",
        context_source: "recent",
        content: "前の文脈",
        created_at: "2026-05-03T09:45:00.000Z",
      },
      {
        message_id: "ctx_2",
        author_id: "bot_1",
        author_display_name: "",
        author_is_bot: true,
        channel_id: "",
        thread_id: "",
        reply_to_message_id: "",
        context_source: "recent",
        content: "bot文脈",
        created_at: "2026-05-03T09:50:00.000Z",
      },
    ]);
    expect(payload.context.conversation).toMatchObject({
      source: "discord_history",
      used_messages: 2,
      included_bot_messages: 1,
      truncated: false,
    });
    expect(payload.context.active_thread_age_minutes).toBe(15);
    expect(payload.context.has_promised_followup).toBe(false);
    expect(payload.context.matched_followup_ids).toEqual([]);
  });

  it("adds conservative Discord n8n intent flags to OpenClaw payloads", () => {
    const allowedChannelIds = new Set(["1465296404455882860"]);
    const build = (content, options = {}) => buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: options.messageId || "msg_discord_intent",
        author: { id: "user_1", username: "user" },
        channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content,
      mentionsBot: options.mentionsBot !== false,
      allowedChannelIds,
    });

    const channelReadPayload = build("<@bot_1> このチャンネルの直近を要約して");
    expect(channelReadPayload.context.discord).toEqual({
      explicit_read_requested: true,
      explicit_write_requested: false,
      explicit_server_read_requested: false,
    });
    expect(channelReadPayload.execution).toEqual({ mode: "direct_agent", reason: "discord_read_intent" });

    const serverReadPayload = build("<@bot_1> サーバー全体の直近投稿を要約して", { messageId: "msg_server_read" });
    expect(serverReadPayload.context.discord).toMatchObject({
      explicit_read_requested: true,
      explicit_write_requested: false,
      explicit_server_read_requested: true,
    });
    expect(serverReadPayload.execution).toEqual({ mode: "direct_agent", reason: "discord_server_read_intent" });

    const broadDiscordPayload = build("<@bot_1> このDiscordサーバの中身を広く見て、自分に必要な能力を考えて", { messageId: "msg_broad_discord" });
    expect(broadDiscordPayload.context.discord).toMatchObject({
      explicit_read_requested: true,
      explicit_write_requested: false,
      explicit_server_read_requested: true,
    });
    expect(broadDiscordPayload.execution).toEqual({ mode: "direct_agent", reason: "discord_server_read_intent" });

    const webServerPayload = build("<@bot_1> 開発サーバーの中身を確認して", { messageId: "msg_web_server" });
    expect(webServerPayload.context.discord.explicit_server_read_requested).toBe(false);
    const broadWebServerPayload = build("<@bot_1> 開発サーバを広く確認して", { messageId: "msg_broad_web_server" });
    expect(broadWebServerPayload.context.discord.explicit_server_read_requested).toBe(false);
    const youtubePayload = build("<@bot_1> YouTube の複数チャンネルを確認して", { messageId: "msg_youtube_channels" });
    expect(youtubePayload.context.discord.explicit_server_read_requested).toBe(false);

    const writePayload = build("<@bot_1> ここに短く投稿して", { messageId: "msg_write" });
    expect(writePayload.context.discord).toMatchObject({
      explicit_read_requested: false,
      explicit_write_requested: true,
      explicit_server_read_requested: false,
    });
    expect(writePayload.execution).toEqual({ mode: "direct_agent", reason: "discord_write_intent" });

    const draftPayload = build("<@bot_1> このチャンネルへの投稿案を作って", { messageId: "msg_draft" });
    expect(draftPayload.context.discord.explicit_write_requested).toBe(false);

    const noTriggerPayload = build("このチャンネルの直近を要約して", {
      messageId: "msg_no_trigger",
      mentionsBot: false,
    });
    expect(noTriggerPayload.context.discord).toEqual({
      explicit_read_requested: false,
      explicit_write_requested: false,
      explicit_server_read_requested: false,
    });
    expect(noTriggerPayload.execution).toEqual({ mode: "json_contract", reason: "not_explicit_trigger" });
  });

  it("caps OpenClaw recent context entries by count and total chars", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const contextEntries = Array.from({ length: 12 }, (_, index) => ({
      message_id: `ctx_${index}`,
      author_user_id: "user_1",
      author_is_bot: false,
      content: `${index}: ${"x".repeat(800)}`,
      created_at: `2026-05-03T09:${String(index).padStart(2, "0")}:00.000Z`,
    }));

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
      content: "相談したいです",
      mentionsBot: true,
      allowedChannelIds,
      contextEntries,
    });

    expect(payload.context.recent_messages.length).toBeLessThanOrEqual(5);
    expect(payload.context.recent_messages.reduce((sum, entry) => sum + entry.content.length, 0))
      .toBeLessThanOrEqual(1000);
    expect(payload.context.recent_messages.every((entry) => entry.content.length <= 300)).toBe(true);
  });

  it("removes current message and OpenClaw operational noise from recent context", () => {
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
      mentionsBot: true,
      allowedChannelIds,
      contextEntries: [
        {
          message_id: "ctx_keep",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "直前の人間投稿",
          created_at: "2026-05-03T09:45:00.000Z",
        },
        {
          message_id: "ctx_failure",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "Context overflow: prompt too large for the model.",
          created_at: "2026-05-03T09:50:00.000Z",
        },
        {
          message_id: "ctx_fixed_notice",
          author_user_id: "user_1",
          author_is_bot: false,
          content: "OpenClaw 直接実行に失敗しました。時間をおいてもう一度試してください。",
          created_at: "2026-05-03T09:55:00.000Z",
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

    expect(payload.context.recent_messages).toEqual([
      {
        message_id: "ctx_keep",
        author_id: "user_1",
        content: "直前の人間投稿",
        created_at: "2026-05-03T09:45:00.000Z",
      },
    ]);
    expect(payload.context.active_thread_age_minutes).toBe(5);
  });

  it("uses uncapped context entries for active thread age while sending capped recent messages", () => {
    const allowedChannelIds = new Set(["1094907178671939654"]);
    const contextEntries = Array.from({ length: 12 }, (_, index) => ({
      message_id: `ctx_${index}`,
      author_user_id: "user_1",
      author_is_bot: false,
      content: `${index}: ${"x".repeat(800)}`,
      created_at: `2026-05-03T09:${String(index).padStart(2, "0")}:00.000Z`,
    }));

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
      content: "相談したいです",
      mentionsBot: true,
      allowedChannelIds,
      contextEntries,
    });

    expect(payload.context.recent_messages.at(-1).message_id).toBe("ctx_11");
    expect(payload.context.active_thread_age_minutes).toBe(49);
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

    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "841686630271418429",
      }).channelRegistry["841686630271418429"].status
    ).toBe("verified");
  });

  it("allows verified Vostok projects and rejects ops entries", () => {
    const baseEnv = {
      FAIRY_RUNTIME_MODE: "openclaw",
      OPENCLAW_API_BASE_URL: "https://openclaw.example/discord/respond",
      OPENCLAW_API_KEY: "key",
      GUILD_ID: "guild_1",
    };

    expect(DEFAULT_CHANNEL_REGISTRY["1465296404455882860"].status).toBe("verified");
    expect(DEFAULT_CHANNEL_REGISTRY["1466404431217164288"].status).toBe("verified");
    expect(DEFAULT_CHANNEL_REGISTRY["1465295987236143319"].status).toBe("verified");
    expect(DEFAULT_CHANNEL_REGISTRY["840827137451229208"].status).toBe("known");

    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465296404455882860,1466404431217164288",
      }).channelRegistry["1466404431217164288"].status
    ).toBe("verified");

    expect(
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465295987236143319",
      }).channelRegistry["1465295987236143319"].status
    ).toBe("verified");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,840827137451229208",
      })
    ).toThrow("840827137451229208");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,1465295987236143319",
        FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON:
          '[{"channel_id":"1465295987236143319","name":"vostok-vol02-pd","type":"project","status":"verified"}]',
      })
    ).toThrow("canonical registry not verified");

    expect(() =>
      createOpenClawRuntimeConfig({
        ...baseEnv,
        FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS: "1094907178671939654,999999999999999999",
        FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON:
          '{"999999999999999999":{"name":"unknown-project","type":"project","status":"verified"}}',
      })
    ).toThrow("canonical registry not verified");
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

  it("adds restricted policy metadata for the verified Vostok QA project", () => {
    const allowedChannelIds = new Set(["1466404431217164288"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1466404431217164288", name: "vostok-vol02-qa" },
      message: {
        id: "msg_vostok_qa",
        author: { id: "user_1", username: "user" },
        channel: { id: "1466404431217164288", name: "vostok-vol02-qa" },
        createdAt: new Date("2026-05-07T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "QAの未回答らしきものを整理してください",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(payload.channel.type).toBe("project");
    expect(payload.channel.policy).toMatchObject({
      rollout_scope: "vostok_qa_restricted",
      allowed_work: ["surface_unanswered_items"],
      forbidden_work: ["assign_owner", "set_due_date", "set_priority", "make_decisions"],
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

  it("uses verified parent channel registry for link requests when the payload channel is a thread", () => {
    const allowedChannelIds = new Set(["1465296404455882860"]);
    const parentChannel = { id: "1465296404455882860", name: "vostok-vol02-general", parentId: "category_1" };
    const threadChannel = {
      id: "1501907581835153510",
      name: "BOOTH整備",
      isThread: () => true,
      parentId: "1465296404455882860",
      parent: parentChannel,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1501907581835153510", name: "BOOTH整備" },
      message: {
        id: "msg_thread_link_parent_registry",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> このURLの情報を整理して https://dokobasho.com/products/vostok/02/",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(payload.channel).toMatchObject({
      id: "1465296404455882860",
      type: "project",
      registered: true,
      thread_id: "1501907581835153510",
      parent_channel_id: "1465296404455882860",
    });
    expect(payload.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: ["https://dokobasho.com/products/vostok/02/"],
    });
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "整理します" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("allows explicit external URL summary requests in verified project threads", () => {
    const allowedChannelIds = new Set(["1465296404455882860"]);
    const parentChannel = { id: "1465296404455882860", name: "vostok-vol02-general", parentId: "category_1" };
    const threadChannel = {
      id: "1501907581835153510",
      name: "BOOTH整備",
      isThread: () => true,
      parentId: "1465296404455882860",
      parent: parentChannel,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_allowed_link",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-07T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> 以下のURLからある程度情報を拾える？ https://dokobasho.com/products/vostok/02/",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(payload.channel).toMatchObject({
      id: "1465296404455882860",
      type: "project",
      registered: true,
      thread_id: "1501907581835153510",
      parent_channel_id: "1465296404455882860",
    });
    expect(payload.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: ["https://dokobasho.com/products/vostok/02/"],
    });
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId: "1465296404455882860",
        allowedChannelIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });

    const naturalPayload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_allowed_natural_link",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-07T10:01:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> もう一度ここから情報を拾って、BOOTH整備をするにあたっての情報の整理をやって https://dokobasho.com/products/vostok/02/",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(naturalPayload.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: ["https://dokobasho.com/products/vostok/02/"],
    });
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "整理します" }),
        channelId: "1465296404455882860",
        allowedChannelIds,
        payload: naturalPayload,
      })
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("adds safe recent thread link candidates only for explicit read or organize requests", () => {
    const allowedChannelIds = new Set(["1465296404455882860"]);
    const parentChannel = { id: "1465296404455882860", name: "vostok-vol02-general", parentId: "category_1" };
    const threadChannel = {
      id: "1501907581835153510",
      name: "BOOTH整備",
      isThread: () => true,
      parentId: "1465296404455882860",
      parent: parentChannel,
    };
    const contextEntries = [
      {
        message_id: "ctx_safe_link",
        author_user_id: "user_1",
        author_is_bot: false,
        content: "対象は https://dokobasho.com/products/vostok/02/ です",
        created_at: "2026-05-08T09:50:00.000Z",
      },
      {
        message_id: "ctx_duplicate_link",
        author_user_id: "user_2",
        author_is_bot: false,
        content: "同じURL https://dokobasho.com/products/vostok/02/",
        created_at: "2026-05-08T09:55:00.000Z",
      },
      {
        message_id: "ctx_credential_link",
        author_user_id: "user_3",
        author_is_bot: false,
        content: "これは拾わない https://user:pass@example.com/secret",
        created_at: "2026-05-08T09:56:00.000Z",
      },
      {
        message_id: "ctx_notion_link",
        author_user_id: "user_1",
        author_is_bot: false,
        content: "Notion は https://www.notion.so/0123456789abcdef0123456789abcdef",
        created_at: "2026-05-08T09:57:00.000Z",
      },
    ];
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_context_link_candidate",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> 上のリンクとNotionを読んで、BOOTH整備用に情報を整理して",
      mentionsBot: true,
      allowedChannelIds,
      contextEntries,
    });

    expect(payload.message.links).toEqual([]);
    expect(payload.context.link_candidates).toEqual([
      {
        url: "https://dokobasho.com/products/vostok/02/",
        source: "recent_thread",
        message_id: "ctx_duplicate_link",
        author_id: "user_2",
        created_at: "2026-05-08T09:55:00.000Z",
      },
      {
        url: "https://www.notion.so/0123456789abcdef0123456789abcdef",
        source: "recent_thread",
        message_id: "ctx_notion_link",
        author_id: "user_1",
        created_at: "2026-05-08T09:57:00.000Z",
      },
    ]);
    expect(payload.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: [
        "https://dokobasho.com/products/vostok/02/",
        "https://www.notion.so/0123456789abcdef0123456789abcdef",
      ],
    });
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "整理します" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });

    const casualPayload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_context_link_casual",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-08T10:01:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> さっきの件ありがとう",
      mentionsBot: true,
      allowedChannelIds,
      contextEntries,
    });

    expect(casualPayload.context.link_candidates).toEqual([]);
    expect(casualPayload.message.link_request).toBeUndefined();
  });

  it("keeps URL input blocked unless it is explicit and fully covered by the link request", () => {
    const allowedChannelIds = new Set(["1465296404455882860", "1094907178671939654"]);
    const parentChannel = { id: "1465296404455882860", name: "vostok-vol02-general", parentId: "category_1" };
    const threadChannel = {
      id: "1501907581835153510",
      name: "BOOTH整備",
      isThread: () => true,
      parentId: "1465296404455882860",
      parent: parentChannel,
    };
    const baseMessage = {
      id: "msg_blocked_link",
      author: { id: "user_1", username: "user" },
      channel: threadChannel,
      createdAt: new Date("2026-05-07T10:00:00.000Z"),
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
    };
    const build = (content, message = baseMessage, channel = { id: "1465296404455882860", name: "vostok-vol02-general" }) =>
      buildOpenClawPayload({
        eventType: "message_create",
        guildId: "840827137451229205",
        channel,
        message,
        content,
        mentionsBot: true,
        allowedChannelIds,
      });

    const nonExplicit = build("<@bot_1> https://dokobasho.com/products/vostok/02/");
    const withCredentials = build("<@bot_1> このURLから情報を拾える？ https://user:pass@example.com/products/vostok/02/");
    const tooManyLinks = build("<@bot_1> このURLから情報を拾える？ https://a.example/ https://b.example/ https://c.example/ https://d.example/");
    const postDraftRequest = build("<@bot_1> live smoke P-4: https://example.com/ を含む投稿案を作ってください。自動投稿せず、扱いだけ確認してください。");
    const unknownChannel = build(
      "<@bot_1> このURLから情報を拾える？ https://dokobasho.com/products/vostok/02/",
      { ...baseMessage, channel: { id: "999999999999999999", name: "unknown" } },
      { id: "999999999999999999", name: "unknown" }
    );
    const regularExternal = build("<@bot_1> このURLから情報を拾える？ https://example.com/products/vostok/02/");
    const notionTargetHandoff = build("<@bot_1> じゃあ、改めて渡すね。\nhttps://dokobasho.com/products/vostok/02/\nこっちが対象のDB。\nhttps://www.notion.so/0123456789abcdef0123456789abcdef");
    const ambiguousDbHandoff = build("<@bot_1> このDB共有 https://example.com/report");
    expect(regularExternal.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: ["https://example.com/products/vostok/02/"],
    });
    expect(notionTargetHandoff.message.link_request).toEqual({
      allowed: true,
      kind: "explicit_external_link_summary",
      urls: [
        "https://dokobasho.com/products/vostok/02/",
        "https://www.notion.so/0123456789abcdef0123456789abcdef",
      ],
    });
    expect(ambiguousDbHandoff.message.link_request).toBeUndefined();

    for (const payload of [nonExplicit, tooManyLinks, postDraftRequest, ambiguousDbHandoff]) {
      expect(payload.message.link_request).toBeUndefined();
      expect(
        runOutboundGate({
          response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
          channelId: payload.channel.id,
          allowedChannelIds,
          payload,
        }).reason
      ).toBe("input_external_link");
    }
    expect(withCredentials.message.link_request).toBeUndefined();
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId: withCredentials.channel.id,
        allowedChannelIds,
        payload: withCredentials,
      }).reason
    ).toBe("input_unsafe_url");
    expect(unknownChannel.message.link_request).toBeUndefined();
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "確認しました" }),
        channelId: unknownChannel.channel.id,
        allowedChannelIds,
        payload: unknownChannel,
      }).reason
    ).toBe("channel_not_verified");
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "受け取りました" }),
        channelId: notionTargetHandoff.channel.id,
        allowedChannelIds,
        payload: notionTargetHandoff,
      })
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("allows Notion links through the input gate with explicit Notion context", () => {
    const allowedChannelIds = new Set(["1465296404455882860"]);
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_notion",
        author: { id: "user_1", username: "user" },
        channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> この Notion に追記して https://www.notion.so/0123456789abcdef0123456789abcdef",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(payload.message.notion_links).toEqual(["https://www.notion.so/0123456789abcdef0123456789abcdef"]);
    expect(payload.context.notion).toMatchObject({
      links: ["https://www.notion.so/0123456789abcdef0123456789abcdef"],
      explicit_write_requested: true,
      destructive_request: false,
      target_provided: true,
    });
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "追記先を確認したよ" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });
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

    expect(DEFAULT_CHANNEL_REGISTRY["841686630271418429"].status).toBe("verified");
    expect(payload.channel.type).toBe("creation");
    expect(payload.channel.registered).toBe(true);
  });

  it("allows the verified 配信部屋 voice channel chat by its own channel id", () => {
    const allowedChannelIds = new Set(["985145703774978059"]);
    const voiceChannel = {
      id: "985145703774978059",
      name: "配信部屋",
      type: 2,
      parentId: "1098535279549235280",
      isThread: () => false,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "985145703774978059", name: "配信部屋" },
      message: {
        id: "msg_voice_channel_chat",
        author: { id: "user_1", username: "user" },
        channel: voiceChannel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> 配信中のメモを一言で整理して",
      mentionsBot: true,
      allowedChannelIds,
    });

    expect(payload.channel.id).toBe("985145703774978059");
    expect(payload.channel.category_id).toBe("1098535279549235280");
    expect(payload.channel.type).toBe("chat");
    expect(payload.channel.registered).toBe(true);
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "配信中のメモとして整理するね" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });

    for (const channel of [
      { id: "1098535279549235280", name: "配信部屋", type: 4 },
      { id: "865619584282918982", name: "配信部屋", type: 0, parentId: "1098535279549235280" },
    ]) {
      const rejected = buildOpenClawPayload({
        eventType: "message_create",
        guildId: "840827137451229205",
        channel,
        message: {
          id: `msg_wrong_${channel.id}`,
          author: { id: "user_1", username: "user" },
          channel,
          createdAt: new Date("2026-05-08T10:01:00.000Z"),
          mentions: { everyone: false, roles: { map: () => [] } },
          attachments: [],
        },
        content: "<@bot_1> 配信中のメモを一言で整理して",
        mentionsBot: true,
        allowedChannelIds,
      });
      expect(rejected.channel.registered).toBe(false);
      expect(rejected.channel.id).toBe(channel.id);
      expect(
        runOutboundGate({
          response: validateOpenClawResponse({ action: "reply", body: "整理するね" }),
          channelId: rejected.channel.id,
          allowedChannelIds,
          payload: rejected,
        }).reason
      ).toBe("channel_not_verified");
    }
  });

  it("allows verified child channels by category allowlist without direct channel allowlist", () => {
    const allowedChannelIds = new Set();
    const allowedCategoryIds = new Set(["1098535279549235280"]);
    const channel = {
      id: "865619584282918982",
      name: "配信部屋",
      parentId: "1098535279549235280",
      isThread: () => false,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel,
      message: {
        id: "msg_category_child",
        author: { id: "user_1", username: "user" },
        channel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> 配信内容を整理して",
      mentionsBot: true,
      allowedChannelIds,
      allowedCategoryIds,
    });

    expect(payload.channel).toEqual(expect.objectContaining({
      id: "865619584282918982",
      type: "chat",
      registered: true,
      category_id: "1098535279549235280",
      gate_source: "category",
    }));
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "整理するね" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        allowedCategoryIds,
        payload,
      })
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("does not allow category children when the actual parent category mismatches the registry", () => {
    const allowedChannelIds = new Set();
    const allowedCategoryIds = new Set(["1098535279549235280"]);
    const channel = {
      id: "865619584282918982",
      name: "配信部屋",
      parentId: "1201092282254893066",
      isThread: () => false,
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel,
      message: {
        id: "msg_category_mismatch",
        author: { id: "user_1", username: "user" },
        channel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> 配信内容を整理して",
      mentionsBot: true,
      allowedChannelIds,
      allowedCategoryIds,
    });

    expect(payload.channel.registered).toBe(false);
    expect(
      runOutboundGate({
        response: validateOpenClawResponse({ action: "reply", body: "整理するね" }),
        channelId: payload.channel.id,
        allowedChannelIds,
        allowedCategoryIds,
        payload,
      }).reason
    ).toBe("channel_not_verified");
  });

  it("denies category gates when uncached thread parent category cannot be verified", () => {
    const allowedChannelIds = new Set();
    const allowedCategoryIds = new Set(["843363361121894400"]);
    const threadChannel = {
      id: "1501907581835153510",
      name: "制作相談",
      isThread: () => true,
      parentId: "1465296404455882860",
    };
    const payload = buildOpenClawPayload({
      eventType: "message_create",
      guildId: "840827137451229205",
      channel: { id: "1465296404455882860", name: "vostok-vol02-general" },
      message: {
        id: "msg_uncached_thread_category",
        author: { id: "user_1", username: "user" },
        channel: threadChannel,
        createdAt: new Date("2026-05-08T10:00:00.000Z"),
        mentions: { everyone: false, roles: { map: () => [] } },
        attachments: [],
      },
      content: "<@bot_1> このスレッドの話を整理して",
      mentionsBot: true,
      allowedChannelIds,
      allowedCategoryIds,
    });

    expect(payload.channel).toEqual(expect.objectContaining({
      id: "1465296404455882860",
      thread_id: "1501907581835153510",
      parent_channel_id: "1465296404455882860",
      category_id: "",
      registered: false,
    }));
  });

  it("allows category gates for threads after fetching the parent category", async () => {
    const allowedCategoryIds = ["843363361121894400"];
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({ action: "reply", body: "整理するね" }),
    };
    const replies = [];
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: [],
      allowedCategoryIds,
      guildId: "840827137451229205",
      requestIdFactory: () => "req_thread_parent_fetch",
    });
    const threadChannel = {
      id: "1501907581835153510",
      name: "制作相談",
      isThread: () => true,
      parentId: "1465296404455882860",
    };
    const message = {
      id: "msg_thread_parent_fetch",
      content: "<@bot_1> このスレッドの話を整理して",
      author: { id: "user_1", username: "user", bot: false },
      channelId: "1501907581835153510",
      guildId: "840827137451229205",
      channel: {
        ...threadChannel,
        sendTyping: jest.fn().mockResolvedValue(undefined),
      },
      client: {
        user: { id: "bot_1" },
        channels: {
          fetch: jest.fn().mockResolvedValue({
            id: "1465296404455882860",
            name: "vostok-vol02-general",
            parentId: "843363361121894400",
          }),
        },
      },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
      reply: jest.fn(async (payload) => {
        replies.push(payload);
        return { id: "reply_1" };
      }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.gate).toEqual({ ok: true, reason: "ok" });
    expect(openClawClient.execute).toHaveBeenCalledTimes(1);
    expect(openClawClient.execute.mock.calls[0][0].channel).toEqual(expect.objectContaining({
      id: "1465296404455882860",
      thread_id: "1501907581835153510",
      category_id: "843363361121894400",
      registered: true,
      gate_source: "category",
    }));
    expect(replies[0].content).toBe("整理するね");
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
          assigneeMemberId: "gho_1234567890abcdef1234567890abcdef1234",
          sourceFollowupId: "sk-proj-1234567890abcdef",
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
          assigneeMemberId: "gho_1234567890abcdef1234567890abcdef1234",
          sourceFollowupId: "sk-proj-1234567890abcdef",
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

  it("validates OpenClaw response body without flattening intentional line breaks", () => {
    const response = validateOpenClawResponse({
      schema_version: 1,
      action: "reply",
      body: "  A=返信量: 短めでOK。  \n  B=安全gate: 自動返信可。  \n\n\n  C=followup: 作成なし。  ",
      reason: "  line\nbreak reason  ",
    });

    expect(response.body).toBe("A=返信量: 短めでOK。\n  B=安全gate: 自動返信可。\n\n  C=followup: 作成なし。");
    expect(response.reason).toBe("line break reason");
  });

  it("preserves nested markdown indentation after validating OpenClaw response", () => {
    const response = validateOpenClawResponse({
      schema_version: 1,
      action: "reply",
      body: "  - 親  \r\n  - 子  \r\n    - 孫  ",
    });

    expect(response.body).toBe("- 親\n  - 子\n    - 孫");
  });

  it("whitelist-normalizes OpenClaw diagnostics without keeping raw unsafe values", () => {
    const response = validateOpenClawResponse({
      schema_version: 1,
      action: "observe",
      body: "",
      reason: "OPENCLAW_TIMEOUT",
      diagnostics: {
        request_id: "req_123",
        reason_code: "OPENCLAW_TIMEOUT",
        attempt_mode: "compact_first",
        elapsed_ms: 1234.8,
        first_attempt_timeout_ms: 75000,
        prompt_chars: "2048",
        initial_prompt_chars: 1024,
        first_attempt_elapsed_ms: 75001,
        retry_count: 1,
        retry_prompt_chars: 512,
        retry_elapsed_ms: 60001,
        retry_stdout_bytes: 0,
        retry_stderr_bytes: 128,
        retry_stderr_line_count: 2,
        retry_stderr_tail_hash: "abcdef1234567890",
        workspace_context_chars: 4096,
        stderr_line_count: 3,
        stderr_tail_hash: "0123456789abcdef",
        error_code: "OPENCLAW_EXIT",
        initial_error_code: "OPENCLAW_TIMEOUT",
        last_stage: "openclaw_timeout",
        retry_last_stage: "openclaw_close",
        retry_skip_reason: "insufficient_time",
        stdout: "raw stdout",
        prompt: "raw prompt",
        discord_body: "raw Discord body",
        stack: "Error: secret\n at app.js:1",
        message: "https://example.com/raw",
        url: "https://example.com",
        secret: "token=abcdefsecret",
      },
    });

    expect(response.diagnostics).toEqual({
      request_id: "req_123",
      reason_code: "OPENCLAW_TIMEOUT",
      attempt_mode: "compact_first",
      elapsed_ms: 1234,
      first_attempt_timeout_ms: 75000,
      prompt_chars: 2048,
      initial_prompt_chars: 1024,
      first_attempt_elapsed_ms: 75001,
      retry_count: 1,
      retry_prompt_chars: 512,
      retry_elapsed_ms: 60001,
      retry_stdout_bytes: 0,
      retry_stderr_bytes: 128,
      retry_stderr_line_count: 2,
      retry_stderr_tail_hash: "abcdef1234567890",
      workspace_context_chars: 4096,
      stderr_line_count: 3,
      stderr_tail_hash: "0123456789abcdef",
      error_code: "OPENCLAW_EXIT",
      initial_error_code: "OPENCLAW_TIMEOUT",
      last_stage: "openclaw_timeout",
      retry_last_stage: "openclaw_close",
      retry_skip_reason: "insufficient_time",
    });
    expect(JSON.stringify(response.diagnostics)).not.toContain("raw stdout");
    expect(JSON.stringify(response.diagnostics)).not.toContain("https://example.com");
    expect(JSON.stringify(response.diagnostics)).not.toContain("abcdefsecret");
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
        {
          summary: "url/ghs_1234567890abcdef1234567890abcdef1234",
          due_at: "2026-05-05T13:00:00.000Z",
          notes: "abc=gho_1234567890abcdef1234567890abcdef1234",
        },
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
    expect(JSON.stringify(state)).not.toContain("ghs_1234567890abcdef1234567890abcdef1234");
    expect(JSON.stringify(state)).not.toContain("gho_1234567890abcdef1234567890abcdef1234");
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

  it("passes stripped slash command content and allowed channel ids to context source", async () => {
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "確認しました",
        requires_approval: false,
      }),
    };
    const contextEntriesSource = jest.fn().mockResolvedValue([]);
    const handler = createOpenClawInteractionHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource,
      requestIdFactory: () => "req_interaction_context",
    });
    const interaction = {
      id: "interaction_1",
      commandName: "fairy",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      user: { id: "user_1", bot: false, username: "user" },
      member: { displayName: "user" },
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      options: { getString: jest.fn(() => "Discord URL を見て") },
      isChatInputCommand: () => true,
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue({ id: "reply_interaction_context" }),
    };

    await handler(interaction);

    expect(contextEntriesSource).toHaveBeenCalledWith(expect.objectContaining({
      interaction,
      content: "Discord URL を見て",
      operationChannelId: "1094907178671939654",
      allowedChannelIds: expect.any(Set),
    }));
  });

  it("passes stripped message content and allowed channel ids to context source", async () => {
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "reply",
        body: "確認しました",
        requires_approval: false,
      }),
    };
    const contextEntriesSource = jest.fn().mockResolvedValue([]);
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource,
      requestIdFactory: () => "req_message_context",
    });
    const message = {
      id: "msg_context_source",
      content: "<@bot_1> Discord URL を見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_message_context" }),
    };

    await handler(message, { messageTriggerSource: "mention" });

    expect(contextEntriesSource).toHaveBeenCalledWith(expect.objectContaining({
      message,
      content: "Discord URL を見て",
      operationChannelId: "1094907178671939654",
      allowedChannelIds: expect.any(Set),
    }));
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
      content: "-# 今回は自動送信せず止めました。\n-# 詳細: reason_code=input_external_link",
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
      content: "-# 今回は自動送信せず止めました。\n-# 詳細: reason_code=input_role_mention",
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
        {
          id: "future_1",
          channel_id: "1094907178671939654",
          channel_type: "sandbox",
          source_message_id: "source_future",
          requested_by_member_id: "user_1",
          summary: "まだ先",
          due_at: "2026-05-06T10:00:00.000Z",
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
        checked_followup_ids: ["checked_1", "future_1"],
        closed_followup_ids: ["closed_1", "future_1"],
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
      expect.objectContaining({
        id: "future_1",
        status: "open",
        last_checked_at: null,
        closed_at: null,
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
        body: "- 親\n  - 子\n    - 孫",
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
      content: "- 親\n  - 子\n    - 孫",
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
        content: `-# 今回は自動送信せず止めました。\n-# 詳細: reason_code=${testCase.reason}`,
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

  it.each(["OPENCLAW_TIMEOUT", "OPENCLAW_SESSION_CLEANUP_FAILED", "context_overflow", "openclaw_error_text"])(
    "replies with a safe failure message when OpenClaw failure %s is normalized to observe",
    async (reason) => {
    const openClawClient = {
      execute: jest.fn().mockResolvedValue({
        schema_version: 1,
        action: "observe",
        body: "",
        reason,
        requires_approval: false,
        diagnostics: {
          request_id: "raw request id with spaces",
          reason_code: reason,
          attempt_mode: "full_first",
          elapsed_ms: 2001,
          first_attempt_timeout_ms: 75000,
          prompt_chars: 1234,
          first_attempt_elapsed_ms: 75001,
          retry_count: 1,
          retry_prompt_chars: 555,
          retry_elapsed_ms: 60001,
          retry_stderr_line_count: 2,
          retry_stderr_tail_hash: "abcdef1234567890",
          retry_last_stage: "openclaw_timeout",
          error_code: "OPENCLAW_EXIT",
          last_stage: "openclaw_timeout",
          stderr_line_count: 3,
          stderr_tail_hash: "0123456789abcdef",
          stdout: "raw stdout must not be shown",
          message: "https://example.com/raw",
        },
      }),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_observe_timeout",
    });
    const message = {
      id: "msg_observe_timeout",
      content: "<@bot_1> 見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_observe_timeout" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.gate.reason).toBe("non_posting_action:observe");
    expect(result.replyMessageId).toBe("reply_observe_timeout");
    expect(message.reply).toHaveBeenCalledWith({
      content:
        "-# OpenClaw 直接実行に失敗しました。時間をおいてもう一度試してください。\n" +
        `-# 詳細: request_id=req_observe_timeout reason_code=${reason} attempt_mode=full_first elapsed_ms=2001 first_attempt_timeout_ms=75000 prompt_chars=1234 first_attempt_elapsed_ms=75001 retry_count=1 retry_prompt_chars=555 retry_elapsed_ms=60001 retry_stderr_line_count=2 stderr_line_count=3 error_code=OPENCLAW_EXIT last_stage=openclaw_timeout retry_last_stage=openclaw_timeout stderr_tail_hash=0123456789abcdef retry_stderr_tail_hash=abcdef1234567890`,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    expect(message.reply.mock.calls[0][0].content).not.toContain("raw stdout");
    expect(message.reply.mock.calls[0][0].content).not.toContain("https://example.com");
  });

  it("replies with safe client diagnostics on OpenClaw client catch without exposing error messages", async () => {
    const openClawClient = {
      execute: jest.fn().mockRejectedValue(Object.assign(new Error("raw https://example.com stack token=abcdefsecret"), {
        code: "OPENCLAW_CLIENT_TIMEOUT",
      })),
    };
    const handler = createOpenClawMessageHandler({
      openClawClient,
      allowedChannelIds: ["1094907178671939654"],
      guildId: "840827137451229205",
      contextEntriesSource: async () => [],
      requestIdFactory: () => "req_client_timeout",
    });
    const message = {
      id: "msg_client_timeout",
      content: "<@bot_1> 見て",
      channelId: "1094907178671939654",
      guildId: "840827137451229205",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      author: { id: "user_1", bot: false, username: "user" },
      client: { user: { id: "bot_1" } },
      channel: { id: "1094907178671939654", name: "妖精さんより", sendTyping: jest.fn().mockResolvedValue(undefined) },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_client_timeout" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.replyMessageId).toBe("reply_client_timeout");
    expect(message.reply).toHaveBeenCalledWith({
      content:
        "-# OpenClaw 直接実行に失敗しました。時間をおいてもう一度試してください。\n" +
        "-# 詳細: request_id=req_client_timeout reason_code=client_error error_code=OPENCLAW_CLIENT_TIMEOUT",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    expect(message.reply.mock.calls[0][0].content).not.toContain("https://example.com");
    expect(message.reply.mock.calls[0][0].content).not.toContain("abcdefsecret");
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
    for (const body of [
      "token=synthetic-secret-value",
      "Authorization: Bearer syntheticBearer12345",
      "Authorization:Bearer syntheticBearer12345",
      "Authorization:Basic c3ludGhldGljMTIzNDU=",
      "OPENCLAW_API_KEY=syntheticSecret12345",
      "DISCORD_BOT_TOKEN=syntheticSecret12345",
      "N8N_WEBHOOK_SECRET=syntheticSecret12345",
      "OPENAI_API_KEY=\"syntheticSecret12345\"",
      "BOT_TOKEN='syntheticSecret12345'",
      "N8N_WEBHOOK_SECRET: \"syntheticSecret12345\"",
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
