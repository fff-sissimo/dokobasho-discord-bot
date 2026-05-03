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
        { message_id: "ctx_1", author_user_id: "user_1", author_is_bot: false, content: "前の文脈" },
        { message_id: "ctx_2", author_user_id: "bot_1", author_is_bot: true, content: "bot文脈" },
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
      { message_id: "ctx_1", author_id: "user_1", content: "前の文脈" },
    ]);
  });

  it("posts OpenClaw response with empty allowed mentions", async () => {
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
      channel: { id: "1094907178671939654", name: "妖精さんより" },
      mentions: { everyone: false, roles: { map: () => [] } },
      attachments: [],
      reply: jest.fn().mockResolvedValue({ id: "reply_1" }),
    };

    const result = await handler(message, { messageTriggerSource: "mention" });

    expect(result.handled).toBe(true);
    expect(result.gate).toEqual({ ok: true, reason: "ok" });
    expect(message.reply).toHaveBeenCalledWith({
      content: "確認しました",
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
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
