const {
  assertSlowPathJobPayloadContract: assertRealSlowPathPayloadContract,
} = require("../src/slow-path-payload-contract");

const loadFastPathWithAdapter = (assertImpl) => {
  jest.resetModules();
  jest.doMock("../src/fairy-core-adapter", () => ({
    fairyCoreAdapter: {
      buildFallbackFirstReplyMessage: (_message, route = "slash_command") =>
        ({
          slash_command: "-# 受け付けたよ。内容を確認して返すね。",
          mention: "-# 呼んでくれてありがとう。内容を確認して返すね。",
          reply: "-# 返信ありがとう。内容を確認して返すね。",
        })[route],
      normalizeFirstReplyForDiscord: (_raw, fallback) => fallback,
      assertSlowPathJobPayloadContract: assertImpl,
      SLOW_PATH_PAYLOAD_SCHEMA_VERSION: "3",
      SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
    },
  }));
  return require("../src/fairy-fast-path");
};

describe("fairy fast path payload contract integration", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("../src/fairy-core-adapter");
  });

  it("interaction payload が契約違反なら enqueue せず失敗メッセージへ更新する", async () => {
    const { createFairyInteractionHandler, FAIRY_COMMAND_NAME } = loadFastPathWithAdapter(() => {
      throw new Error("invalid field: channel_id");
    });
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue },
      requestIdFactory: () => "RQ-20260223-000000000-contract000001",
      enqueueAttempts: 1,
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: FAIRY_COMMAND_NAME,
      id: "evt_contract_001",
      applicationId: "app_contract_001",
      user: { id: "user_contract_001" },
      channelId: "channel_contract_001",
      guildId: null,
      options: { getString: () => "テスト" },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    const result = await handler(interaction);
    const editContents = interaction.editReply.mock.calls.map((args) => args[0].content);

    expect(result.handled).toBe(true);
    expect(result.enqueueError).toContain("slow-path payload contract failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(editContents[1]).toContain("後続処理の投入に失敗したため自動処理を開始できませんでした。");
  });

  it("message payload が契約違反なら enqueue せず返信を失敗メッセージへ更新する", async () => {
    const { createFairyMessageHandler } = loadFastPathWithAdapter(() => {
      throw new Error("invalid field: channel_id");
    });
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const replyEdit = jest.fn().mockResolvedValue(undefined);
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      requestIdFactory: () => "RQ-20260223-000000000-contract000002",
      enqueueAttempts: 1,
    });
    const message = {
      id: "msg_contract_001",
      content: "<@1100870989518213200> テスト",
      createdAt: new Date("2026-02-23T12:01:00.000Z"),
      channelId: "channel_contract_002",
      guildId: "guild_contract_002",
      author: { id: "user_contract_002", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_contract_002" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_contract_001", edit: replyEdit }),
    };

    const result = await handler(message, {
      messageTriggerSource: "mention",
      sourceMessageId: message.id,
    });

    expect(result.handled).toBe(true);
    expect(result.enqueueError).toContain("slow-path payload contract failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(replyEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("後続処理の投入に失敗したため自動処理を開始できませんでした。"),
      })
    );
  });

  it("message payload は実際の schema v3 契約でも通る", async () => {
    const { createFairyMessageHandler } = loadFastPathWithAdapter(assertRealSlowPathPayloadContract);
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const replyEdit = jest.fn().mockResolvedValue(undefined);
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["ctx_line_001"],
      contextEntriesSource: async () => [
        {
          message_id: "ctx_001",
          author_user_id: "user_ctx_001",
          author_is_bot: false,
          content: "ctx_line_001",
        },
      ],
      requestIdFactory: () => "RQ-20260223-000000000-contract000003",
      enqueueAttempts: 1,
    });
    const message = {
      id: "msg_contract_003",
      content: "<@1100870989518213200> これを確認して",
      createdAt: new Date("2026-02-23T12:02:00.000Z"),
      channelId: "channel_contract_003",
      guildId: "guild_contract_003",
      author: { id: "user_contract_003", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_contract_003" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_contract_003", edit: replyEdit }),
    };

    const result = await handler(message, {
      messageTriggerSource: "mention",
      sourceMessageId: message.id,
      replyAntecedentEntry: {
        message_id: "anchor_contract_003",
        author_user_id: "user_anchor_003",
        author_is_bot: false,
        content: "参照先の本文",
      },
    });

    expect(result.handled).toBe(true);
    expect(result.enqueueError).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "3",
        reply_antecedent_entry: {
          message_id: "anchor_contract_003",
          author_user_id: "user_anchor_003",
          author_is_bot: false,
          content: "参照先の本文",
        },
      })
    );
  });

  it("malformed reply antecedent entry は実契約で reject される", async () => {
    const { createFairyMessageHandler } = loadFastPathWithAdapter(assertRealSlowPathPayloadContract);
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const replyEdit = jest.fn().mockResolvedValue(undefined);
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      requestIdFactory: () => "RQ-20260223-000000000-contract000004",
      enqueueAttempts: 1,
    });
    const message = {
      id: "msg_contract_004",
      content: "<@1100870989518213200> これを確認して",
      createdAt: new Date("2026-02-23T12:03:00.000Z"),
      channelId: "channel_contract_004",
      guildId: "guild_contract_004",
      author: { id: "user_contract_004", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_contract_004" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_contract_004", edit: replyEdit }),
    };

    const result = await handler(message, {
      messageTriggerSource: "reply",
      sourceMessageId: message.id,
      replyAntecedentEntry: {
        message_id: "anchor_contract_004",
        author_user_id: "",
        author_is_bot: false,
        content: "参照先の本文",
      },
    });

    expect(result.handled).toBe(true);
    expect(result.enqueueError).toContain("slow-path payload contract failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("後続処理の投入に失敗したため自動処理を開始できませんでした。"),
      })
    );
    expect(replyEdit).not.toHaveBeenCalled();
  });
});
