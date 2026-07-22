describe("index image generation integration", () => {
  const setup = ({
    imageMessageResult = { handled: true },
    imageConfig = {},
    openAiApiKey = "",
  } = {}) => {
    jest.resetModules();
    process.env.FAIRY_ENABLED = "true";
    if (openAiApiKey) {
      process.env.OPENAI_API_KEY = openAiApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    const handlers = {};
    const imageHandler = {
      handleMessage: jest.fn().mockResolvedValue(imageMessageResult),
      handleInteraction: jest.fn().mockResolvedValue({ handled: true }),
    };
    const fairyMessageHandler = jest.fn().mockResolvedValue({ handled: true, requestId: "fairy-1" });
    const handleCommand = jest.fn();
    const handleButton = jest.fn();
    const createImageGenerationService = jest.fn(() => ({ service: true }));
    const createImageGenerationDiscordHandler = jest.fn(() => imageHandler);
    const createOpenAiImageIntentDetector = jest.fn(() => jest.fn());
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const client = {
      user: { id: "bot_001", tag: "bot#0001" },
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      once: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      login: jest.fn().mockResolvedValue("ok"),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock("discord.js", () => ({
      Client: jest.fn(() => client),
      GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 32 },
      Events: { ClientReady: "clientReady", InteractionCreate: "interactionCreate" },
      MessageFlags: { Ephemeral: 64 },
    }), { virtual: true });
    jest.doMock("dotenv", () => ({ config: jest.fn(() => ({})) }), { virtual: true });
    jest.doMock("../src/config", () => ({ getBotToken: () => "token" }));
    jest.doMock("../src/google-sheets", () => ({ getSheetsClient: jest.fn() }));
    jest.doMock("../src/command-handler", () => ({ handleCommand, handleButton }));
    jest.doMock("../src/fairy-fast-path", () => ({
      FAIRY_COMMAND_NAME: "fairy",
      createSlowPathWebhookClient: jest.fn(() => ({})),
      createFairyInteractionHandler: jest.fn(() => jest.fn().mockResolvedValue({ handled: true })),
      createFairyMessageHandler: jest.fn(() => fairyMessageHandler),
    }));
    jest.doMock("../src/reply-antecedent", () => ({
      resolveReplyAntecedentEntry: jest.fn().mockResolvedValue(undefined),
    }));
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
          fairyDisabled: "fairy disabled",
          fairyNotConfigured: "fairy not configured",
        },
        imageGeneration: {
          errors: {
            credential_error: "image not configured",
          },
        },
      },
    }));
    jest.doMock("../src/n8n-webhook", () => ({
      createWebhookRequestBuilder: jest.fn(() => ({
        shouldSend: jest.fn(() => false),
        buildHeaders: jest.fn(() => ({})),
      })),
    }));
    jest.doMock("../src/image-generation-config", () => ({
      parseImageGenerationConfig: jest.fn(() => ({
        enabled: true,
        webhookToken: "webhook-token",
        intentConfidenceThreshold: 0.8,
        confirmationTtlSeconds: 180,
        ...imageConfig,
      })),
    }));
    jest.doMock("../src/image-generation-intent", () => ({
      createImageGenerationIntentDetector: jest.fn(() => ({ detect: jest.fn() })),
    }));
    jest.doMock("../src/image-generation-service", () => ({
      createImageGenerationService,
    }));
    jest.doMock("../src/image-generation-discord-handler", () => ({
      IMAGE_BUTTON_PREFIX: "imagegen",
      createImageGenerationDiscordHandler,
    }));
    jest.doMock("../src/image-generation-openai-intent", () => ({
      createOpenAiImageIntentDetector,
    }));

    jest.isolateModules(() => {
      require("../index");
    });

    const message = {
      id: "msg-1",
      content: "画像生成して",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      author: { id: "user-1", bot: false, username: "alice" },
      mentions: {
        repliedUser: null,
        users: { has: jest.fn(() => true) },
      },
      reference: null,
      channel: { id: "channel-1" },
      guild: { id: "guild-1" },
    };

    return {
      handlers,
      imageHandler,
      fairyMessageHandler,
      handleCommand,
      handleButton,
      createImageGenerationService,
      createImageGenerationDiscordHandler,
      createOpenAiImageIntentDetector,
      message,
    };
  };

  afterEach(() => {
    delete process.env.FAIRY_ENABLED;
    delete process.env.OPENAI_API_KEY;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("normal message path calls image handler before fairy gate and returns when handled", async () => {
    const { handlers, imageHandler, fairyMessageHandler, message } = setup();

    await handlers.messageCreate(message);

    expect(imageHandler.handleMessage).toHaveBeenCalledWith(message);
    expect(fairyMessageHandler).not.toHaveBeenCalled();
  });

  test("falls through to fairy message handler when image handler does not handle", async () => {
    const { handlers, imageHandler, fairyMessageHandler, message } = setup({
      imageMessageResult: { handled: false },
    });

    await handlers.messageCreate(message);

    expect(imageHandler.handleMessage).toHaveBeenCalledWith(message);
    expect(fairyMessageHandler).toHaveBeenCalled();
  });

  test("/image and image buttons route to image handler", async () => {
    const { handlers, imageHandler } = setup();
    const slash = {
      isChatInputCommand: jest.fn(() => true),
      isButton: jest.fn(() => false),
      commandName: "image",
    };
    const button = {
      isChatInputCommand: jest.fn(() => false),
      isButton: jest.fn(() => true),
      customId: "imagegen:confirm:req-1",
    };

    await handlers.interactionCreate(slash);
    await handlers.interactionCreate(button);

    expect(imageHandler.handleInteraction).toHaveBeenCalledWith(slash);
    expect(imageHandler.handleInteraction).toHaveBeenCalledWith(button);
  });

  test("delete-confirm button remains reminder handler", async () => {
    const { handlers, imageHandler, handleButton } = setup();
    const interaction = {
      isChatInputCommand: jest.fn(() => false),
      isButton: jest.fn(() => true),
      customId: "delete-confirm_key1",
    };

    await handlers.interactionCreate(interaction);

    expect(imageHandler.handleInteraction).not.toHaveBeenCalled();
    expect(handleButton).toHaveBeenCalledWith(interaction);
  });

  test("does not initialize image runtime when image generation is disabled", async () => {
    const {
      handlers,
      imageHandler,
      createImageGenerationService,
      createImageGenerationDiscordHandler,
      createOpenAiImageIntentDetector,
      message,
    } = setup({ imageConfig: { enabled: false }, openAiApiKey: "sk-test" });

    await handlers.messageCreate(message);

    expect(createImageGenerationService).not.toHaveBeenCalled();
    expect(createImageGenerationDiscordHandler).not.toHaveBeenCalled();
    expect(createOpenAiImageIntentDetector).not.toHaveBeenCalled();
    expect(imageHandler.handleMessage).not.toHaveBeenCalled();
  });

  test("does not initialize image runtime or OpenAI detector when webhook token is missing", () => {
    const {
      createImageGenerationService,
      createImageGenerationDiscordHandler,
      createOpenAiImageIntentDetector,
    } = setup({
      imageConfig: { enabled: true, webhookToken: "" },
      openAiApiKey: "sk-test",
    });

    expect(createImageGenerationService).not.toHaveBeenCalled();
    expect(createImageGenerationDiscordHandler).not.toHaveBeenCalled();
    expect(createOpenAiImageIntentDetector).not.toHaveBeenCalled();
  });
});
