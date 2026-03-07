describe("index fairy message trigger integration", () => {
  const setup = ({ fetchReferenceAuthorId = "bot_001", repliedUserId = "bot_001", adapterThrows = false } = {}) => {
    jest.resetModules();

    const handlers = {};
    const fairyMessageHandler = jest.fn().mockResolvedValue({
      handled: true,
      requestId: "RQ-20260308-000000000-index000001",
      firstReplyLatencyMs: 12,
      firstReplySource: "fallback",
    });
    const resolveReplyAntecedentEntry = jest.fn().mockResolvedValue({
      message_id: "anchor_001",
      author_user_id: "user_anchor_001",
      author_is_bot: false,
      content: "参照先の本文",
    });
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const client = {
      user: { id: "bot_001" },
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      once: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      login: jest.fn().mockResolvedValue("ok"),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock(
      "discord.js",
      () => ({
        Client: jest.fn(() => client),
        GatewayIntentBits: {
          Guilds: 1,
          GuildMessages: 2,
          MessageContent: 4,
          GuildMessageReactions: 8,
          DirectMessages: 16,
        },
        Events: {
          ClientReady: "clientReady",
          InteractionCreate: "interactionCreate",
        },
      }),
      { virtual: true }
    );
    jest.doMock(
      "dotenv",
      () => ({
        config: jest.fn(() => ({})),
      }),
      { virtual: true }
    );
    jest.doMock("../src/config", () => ({
      getBotToken: () => "token_001",
    }));
    jest.doMock("../src/google-sheets", () => ({
      getSheetsClient: jest.fn(),
    }));
    jest.doMock("../src/command-handler", () => ({
      handleCommand: jest.fn(),
      handleButton: jest.fn(),
    }));
    jest.doMock("../src/fairy-fast-path", () => ({
      FAIRY_COMMAND_NAME: "fairy",
      DEFAULT_FAST_PATH_CAPS: { maxMessages: 20 },
      createSlowPathWebhookClient: jest.fn(() => ({
        shouldSend: jest.fn(() => false),
        buildHeaders: jest.fn(() => ({})),
      })),
      createFairyInteractionHandler: jest.fn(() => jest.fn()),
      createFairyMessageHandler: jest.fn(() => fairyMessageHandler),
    }));
    jest.doMock("../src/reply-antecedent", () => ({
      resolveReplyAntecedentEntry,
    }));
    jest.doMock("../src/fairy-core-adapter", () => {
      if (adapterThrows) {
        throw new Error("module not found");
      }
      return {
        fairyCoreAdapter: {
          createOpenAiFirstReplyComposer: jest.fn(),
        },
      };
    });
    jest.doMock("../src/permanent-memory-sync-server", () => ({
      createPermanentMemorySyncServer: jest.fn(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      })),
    }));
    jest.doMock("../src/logger", () => logger);
    jest.doMock("../src/message-templates", () => ({
      MESSAGES: {
        errors: {
          generic: "generic",
          reminderNotConfigured: "reminder",
        },
      },
    }));
    jest.doMock("../src/n8n-webhook", () => ({
      createWebhookRequestBuilder: jest.fn(() => ({
        shouldSend: jest.fn(() => false),
        buildHeaders: jest.fn(() => ({})),
      })),
    }));

    jest.isolateModules(() => {
      require("../index");
    });

    const message = {
      id: "msg_001",
      content: "<@bot_001> これを確認して",
      createdAt: new Date("2026-03-08T00:00:00.000Z"),
      author: { id: "user_001", bot: false, username: "user_001" },
      mentions: {
        repliedUser: repliedUserId ? { id: repliedUserId } : null,
        users: { has: jest.fn((id) => id === "bot_001") },
      },
      reference: { messageId: "anchor_001" },
      fetchReference: jest.fn().mockResolvedValue({
        id: "anchor_001",
        author: { id: fetchReferenceAuthorId, bot: fetchReferenceAuthorId === "bot_001" },
      }),
      channel: { id: "channel_001" },
      guild: { id: "guild_001" },
    };

    return {
      handlers,
      fairyMessageHandler,
      resolveReplyAntecedentEntry,
      logger,
      message,
    };
  };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("reply trigger で antecedent resolver の結果を fairyMessageHandler へ渡す", async () => {
    const { handlers, fairyMessageHandler, resolveReplyAntecedentEntry, message } = setup();

    await handlers.messageCreate(message);

    expect(resolveReplyAntecedentEntry).toHaveBeenCalledWith(message);
    expect(fairyMessageHandler).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        messageTriggerSource: "reply",
        sourceMessageId: "msg_001",
        replyAntecedentEntry: {
          message_id: "anchor_001",
          author_user_id: "user_anchor_001",
          author_is_bot: false,
          content: "参照先の本文",
        },
      })
    );
  });

  it("mention+reply でも replied target semantics を保持して fairyMessageHandler へ渡す", async () => {
    const { handlers, fairyMessageHandler, resolveReplyAntecedentEntry, message } = setup({
      fetchReferenceAuthorId: "user_anchor_999",
      repliedUserId: null,
    });

    await handlers.messageCreate(message);

    expect(resolveReplyAntecedentEntry).toHaveBeenCalledWith(message);
    expect(fairyMessageHandler).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        messageTriggerSource: "mention",
        sourceMessageId: "msg_001",
        replyAntecedentEntry: {
          message_id: "anchor_001",
          author_user_id: "user_anchor_001",
          author_is_bot: false,
          content: "参照先の本文",
        },
      })
    );
  });

  it("pure mention では antecedent resolver を呼ばず undefined のまま処理する", async () => {
    const { handlers, fairyMessageHandler, resolveReplyAntecedentEntry, message } = setup({
      fetchReferenceAuthorId: "user_anchor_999",
      repliedUserId: null,
    });
    message.reference = null;

    await handlers.messageCreate(message);

    expect(resolveReplyAntecedentEntry).not.toHaveBeenCalled();
    expect(fairyMessageHandler).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        messageTriggerSource: "mention",
        sourceMessageId: "msg_001",
        replyAntecedentEntry: undefined,
      })
    );
  });

  it("reply だが antecedent resolver が undefined を返す場合でも処理は継続する", async () => {
    const { handlers, fairyMessageHandler, resolveReplyAntecedentEntry, message } = setup();
    resolveReplyAntecedentEntry.mockResolvedValueOnce(undefined);

    await handlers.messageCreate(message);

    expect(resolveReplyAntecedentEntry).toHaveBeenCalledWith(message);
    expect(fairyMessageHandler).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        messageTriggerSource: "reply",
        sourceMessageId: "msg_001",
        replyAntecedentEntry: undefined,
      })
    );
  });

  it("reply antecedent resolver が例外を投げても処理は継続する", async () => {
    const { handlers, fairyMessageHandler, resolveReplyAntecedentEntry, logger, message } = setup();
    resolveReplyAntecedentEntry.mockRejectedValueOnce(new Error("discord unavailable"));

    await handlers.messageCreate(message);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        messageId: "msg_001",
      }),
      "[fairy] reply antecedent resolution failed"
    );
    expect(fairyMessageHandler).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        messageTriggerSource: "reply",
        replyAntecedentEntry: undefined,
      })
    );
  });

  it("fairy-core adapter の読み込みに失敗しても bot 全体は起動し、fairy だけ disable する", () => {
    const { logger } = setup({ adapterThrows: true });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "[fairy] disabled due to invalid configuration"
    );
  });
});
