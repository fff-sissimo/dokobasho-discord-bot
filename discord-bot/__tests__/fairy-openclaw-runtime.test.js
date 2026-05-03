const {
  SAFE_ALLOWED_MENTIONS,
  buildOpenClawPayload,
  createOpenClawClient,
  createOpenClawMessageHandler,
  createOpenClawRuntimeConfig,
  normalizeRuntimeMode,
  runOutboundGate,
  validateOpenClawResponse,
} = require("../src/fairy-openclaw-runtime");

describe("fairy OpenClaw runtime", () => {
  afterEach(() => {
    jest.useRealTimers();
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
        OPENCLAW_API_URL: "https://openclaw.example/run",
        OPENCLAW_API_KEY: "key",
        GUILD_ID: "guild_1",
      })
    ).toThrow("FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS");
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

  it("sends OpenClaw request with bearer auth", async () => {
    const json = jest.fn().mockResolvedValue({ action: "observe", body: "" });
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json });
    const client = createOpenClawClient({
      apiUrl: "https://openclaw.example/run",
      apiKey: "secret",
      fetchImpl,
      timeoutMs: 100,
    });

    await client.execute({ schema_version: 1 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openclaw.example/run",
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
