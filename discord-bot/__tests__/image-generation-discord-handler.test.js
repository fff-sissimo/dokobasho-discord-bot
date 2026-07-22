const { AttachmentBuilder } = require("discord.js");
const {
  createButtonCustomId,
  createImageGenerationDiscordHandler,
} = require("../src/image-generation-discord-handler");

const pngBase64 = Buffer.from("png-bytes").toString("base64");

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createMessage = () => {
  const confirmationMessage = {
    id: "confirm-message-1",
    edit: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue({ id: "image-message-1" }),
  };
  return {
    id: "message-1",
    content: "画像生成して。暖かい作業場のサムネ。",
    author: { id: "user-1", bot: false, username: "alice" },
    guild: { id: "guild-1" },
    channel: { id: "channel-1" },
    reply: jest.fn().mockResolvedValue(confirmationMessage),
    confirmationMessage,
  };
};

const createButtonInteraction = ({ userId = "user-1", requestId = "req-1", action = "confirm" } = {}) => ({
  isChatInputCommand: jest.fn(() => false),
  isButton: jest.fn(() => true),
  customId: createButtonCustomId(action, requestId),
  user: { id: userId, username: userId },
  deferred: false,
  replied: false,
  reply: jest.fn().mockResolvedValue(undefined),
  followUp: jest.fn().mockResolvedValue(undefined),
  deferUpdate: jest.fn().mockImplementation(function defer() {
    this.deferred = true;
    return Promise.resolve();
  }),
  update: jest.fn().mockResolvedValue(undefined),
  message: {
    id: "confirm-message-1",
    edit: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue({ id: "image-message-1" }),
  },
});

const createSlashInteraction = () => ({
  isChatInputCommand: jest.fn(() => true),
  isButton: jest.fn(() => false),
  commandName: "image",
  id: "interaction-1",
  guildId: "guild-1",
  channelId: "channel-1",
  user: { id: "user-1", username: "alice" },
  deferred: false,
  replied: false,
  deferReply: jest.fn().mockImplementation(function defer() {
    this.deferred = true;
    return Promise.resolve();
  }),
  reply: jest.fn().mockResolvedValue(undefined),
  followUp: jest.fn().mockResolvedValue(undefined),
  editReply: jest.fn().mockResolvedValue(undefined),
  options: {
    getString: jest.fn((name) => ({
      prompt: "画像生成して",
      purpose: "thumbnail",
      model: "standard",
    }[name] || null)),
  },
});

test("natural language handler posts confirmation only for image intent and stores message id", async () => {
  const timers = [];
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
      summary: "暖かい作業場のサムネ",
    }),
    recordConfirmationMessage: jest.fn(),
    expireConfirmation: jest.fn(),
  };
  const handler = createImageGenerationDiscordHandler({
    service,
    setTimeoutFn: jest.fn((fn) => {
      timers.push(fn);
      return { unref: jest.fn() };
    }),
  });
  const message = createMessage();

  const result = await handler.handleMessage(message);

  expect(result.handled).toBe(true);
  expect(service.prepareNaturalLanguageCandidate).toHaveBeenCalledWith(expect.objectContaining({
    text: message.content,
    messageId: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
  }));
  expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining("画像を生成しますか？"),
    components: expect.any(Array),
  }));
  expect(message.reply.mock.calls[0][0].content).toContain("内容: 暖かい作業場のサムネ");
  const componentJson = message.reply.mock.calls[0][0].components[0].toJSON();
  expect(JSON.stringify(componentJson)).toContain("imagegen:confirm:req-1");
  expect(JSON.stringify(componentJson)).not.toContain(message.content);
  expect(service.recordConfirmationMessage).toHaveBeenCalledWith({
    requestId: "req-1",
    confirmationMessageId: "confirm-message-1",
  });

  await timers[0]();
  expect(service.expireConfirmation).toHaveBeenCalledWith({ requestId: "req-1" });
  expect(message.confirmationMessage.edit).toHaveBeenCalledWith(expect.objectContaining({
    content: "期限切れです。",
  }));
});

test("natural language handler ignores non-image/noop results", async () => {
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({ action: "noop" }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();

  await expect(handler.handleMessage(message)).resolves.toMatchObject({ handled: false });
  expect(message.reply).not.toHaveBeenCalled();
});

test("other user confirm and cancel are rejected ephemerally without delivery", async () => {
  const service = {
    confirm: jest.fn().mockResolvedValue({ action: "rejected", reason: "forbidden", requestId: "req-1" }),
    cancel: jest.fn(() => ({ action: "rejected", reason: "forbidden", requestId: "req-1" })),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const confirm = createButtonInteraction({ userId: "other", action: "confirm" });
  const cancel = createButtonInteraction({ userId: "other", action: "cancel" });

  await handler.handleInteraction(confirm);
  await handler.handleInteraction(cancel);

  expect(confirm.deferUpdate).toHaveBeenCalled();
  expect(confirm.followUp).toHaveBeenCalledWith(expect.objectContaining({
    content: "この操作は依頼者本人だけができます。",
    flags: [64],
  }));
  expect(cancel.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: "この操作は依頼者本人だけができます。",
    flags: [64],
  }));
  expect(confirm.update).not.toHaveBeenCalled();
  expect(cancel.update).not.toHaveBeenCalled();
});

test("owner confirm running path ACKs first, then completion sends PNG to original message", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    confirm: jest.fn().mockResolvedValue({
      action: "running",
      requestId: "req-1",
      completionPromise,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();
  await handler.handleMessage(message);
  const interaction = createButtonInteraction({ action: "confirm" });
  interaction.message = message.confirmationMessage;

  await handler.handleInteraction(interaction);

  expect(service.confirm).toHaveBeenCalledTimes(1);
  expect(interaction.deferUpdate).toHaveBeenCalled();
  expect(interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
    service.confirm.mock.invocationCallOrder[0]
  );
  expect(interaction.message.edit).toHaveBeenCalledWith(expect.objectContaining({
    content: "画像生成を受け付けました。少し待ってください。",
  }));
  expect(interaction.message.reply).not.toHaveBeenCalled();
  expect(message.reply).toHaveBeenCalledTimes(1);

  resolveCompletion({
    action: "completed",
    requestId: "req-1",
    image: { base64: pngBase64, mimeType: "image/png" },
  });
  await flush();

  expect(message.reply).toHaveBeenCalledTimes(2);
  const payload = message.reply.mock.calls[1][0];
  expect(payload.content).toBe("");
  expect(payload.files).toHaveLength(1);
  expect(payload.files[0]).toBeInstanceOf(AttachmentBuilder);
  expect(interaction.message.edit).toHaveBeenCalledWith(expect.objectContaining({
    content: "完了しました。",
  }));
});

test("queued completionPromise later posts PNG attachment", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    confirm: jest.fn().mockResolvedValue({
      action: "queued",
      requestId: "req-1",
      position: 2,
      completionPromise,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();
  await handler.handleMessage(message);
  const interaction = createButtonInteraction({ action: "confirm" });
  interaction.message = message.confirmationMessage;

  await handler.handleInteraction(interaction);
  expect(interaction.message.edit).toHaveBeenCalledWith(expect.objectContaining({
    content: "画像生成を受け付けました。現在2番目です。",
  }));
  expect(interaction.message.reply).not.toHaveBeenCalled();

  resolveCompletion({
    action: "completed",
    requestId: "req-1",
    image: { base64: pngBase64, mimeType: "image/png" },
  });
  await flush();

  expect(message.reply).toHaveBeenLastCalledWith(expect.objectContaining({
    files: [expect.any(AttachmentBuilder)],
  }));
});

test("queued cancel keeps cancelled display when completion later resolves cancelled", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    confirm: jest.fn().mockResolvedValue({
      action: "queued",
      requestId: "req-1",
      position: 1,
      completionPromise,
    }),
    cancel: jest.fn(() => ({ action: "cancelled", requestId: "req-1" })),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();
  await handler.handleMessage(message);
  const confirm = createButtonInteraction({ action: "confirm" });
  confirm.message = message.confirmationMessage;

  await handler.handleInteraction(confirm);
  const cancel = createButtonInteraction({ action: "cancel" });
  cancel.message = message.confirmationMessage;
  await handler.handleInteraction(cancel);

  expect(cancel.update).toHaveBeenCalledWith({
    content: "キャンセルしました。",
    components: [],
  });

  resolveCompletion({ action: "cancelled", requestId: "req-1" });
  await flush();

  expect(cancel.update).toHaveBeenCalledWith({
    content: "キャンセルしました。",
    components: [],
  });
  const editedContents = message.confirmationMessage.edit.mock.calls.map((call) => call[0].content);
  expect(editedContents).not.toContain("画像生成に失敗しました。少し時間を置いて再試行してください。");
});

test("queued cancel suppresses later stale completed delivery", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    confirm: jest.fn().mockResolvedValue({
      action: "queued",
      requestId: "req-1",
      position: 1,
      completionPromise,
    }),
    cancel: jest.fn(() => ({ action: "cancelled", requestId: "req-1" })),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();
  await handler.handleMessage(message);
  const confirm = createButtonInteraction({ action: "confirm" });
  confirm.message = message.confirmationMessage;

  await handler.handleInteraction(confirm);
  const cancel = createButtonInteraction({ action: "cancel" });
  cancel.message = message.confirmationMessage;
  await handler.handleInteraction(cancel);

  resolveCompletion({
    action: "completed",
    requestId: "req-1",
    image: { base64: pngBase64, mimeType: "image/png" },
  });
  await flush();

  expect(message.reply).toHaveBeenCalledTimes(1);
  expect(message.confirmationMessage.reply).not.toHaveBeenCalled();
  expect(cancel.update).toHaveBeenCalledWith({
    content: "キャンセルしました。",
    components: [],
  });
  const editedContents = message.confirmationMessage.edit.mock.calls.map((call) => call[0].content);
  expect(editedContents).not.toContain("完了しました。");
});

test("confirm rejection after ACK keeps original display and sends ephemeral safety message", async () => {
  const clearTimeoutFn = jest.fn();
  const service = {
    confirm: jest.fn().mockResolvedValue({ action: "rejected", reason: "not_confirming", requestId: "req-1" }),
  };
  const handler = createImageGenerationDiscordHandler({ service, clearTimeoutFn });
  const interaction = createButtonInteraction({ action: "confirm" });

  await handler.handleInteraction(interaction);

  expect(interaction.deferUpdate).toHaveBeenCalled();
  expect(interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
    service.confirm.mock.invocationCallOrder[0]
  );
  expect(interaction.update).not.toHaveBeenCalled();
  expect(interaction.message.edit).not.toHaveBeenCalled();
  expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
    content: "この画像生成リクエストは現在確認できません。",
    flags: [64],
  }));
  expect(clearTimeoutFn).not.toHaveBeenCalled();
});

test("queued cancel is owner-only and updates message on owner cancellation", async () => {
  const clearTimeoutFn = jest.fn();
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    cancel: jest
      .fn()
      .mockReturnValueOnce({ action: "rejected", reason: "forbidden", requestId: "req-1" })
      .mockReturnValueOnce({ action: "cancelled", requestId: "req-1" }),
  };
  const handler = createImageGenerationDiscordHandler({
    service,
    clearTimeoutFn,
    setTimeoutFn: jest.fn(() => "timer-1"),
  });
  await handler.handleMessage(createMessage());
  const other = createButtonInteraction({ userId: "other", action: "cancel" });
  const owner = createButtonInteraction({ userId: "user-1", action: "cancel" });

  await handler.handleInteraction(other);
  expect(clearTimeoutFn).not.toHaveBeenCalled();
  await handler.handleInteraction(owner);

  expect(other.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: [64] }));
  expect(owner.update).toHaveBeenCalledWith({
    content: "キャンセルしました。",
    components: [],
  });
  expect(clearTimeoutFn).toHaveBeenCalledTimes(1);
});

test("owner cancel before confirm removes original message reference from later stale completion", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    prepareNaturalLanguageCandidate: jest.fn().mockResolvedValue({
      action: "confirm",
      requestId: "req-1",
      purpose: "thumbnail",
    }),
    recordConfirmationMessage: jest.fn(),
    cancel: jest.fn(() => ({ action: "cancelled", requestId: "req-1" })),
    confirm: jest.fn().mockResolvedValue({
      action: "running",
      requestId: "req-1",
      completionPromise,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const message = createMessage();
  await handler.handleMessage(message);
  const cancel = createButtonInteraction({ action: "cancel" });
  cancel.message = message.confirmationMessage;

  await handler.handleInteraction(cancel);
  const staleConfirm = createButtonInteraction({ action: "confirm" });
  staleConfirm.message = message.confirmationMessage;
  await handler.handleInteraction(staleConfirm);

  resolveCompletion({
    action: "completed",
    requestId: "req-1",
    image: { base64: pngBase64, mimeType: "image/png" },
  });
  await flush();

  expect(message.reply).toHaveBeenCalledTimes(1);
  expect(message.confirmationMessage.reply).not.toHaveBeenCalled();
});

test("cancel rejection does not overwrite message", async () => {
  const service = {
    cancel: jest.fn(() => ({ action: "rejected", reason: "not_cancellable", requestId: "req-1" })),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const interaction = createButtonInteraction({ action: "cancel" });

  await handler.handleInteraction(interaction);

  expect(interaction.update).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: "この画像生成リクエストはキャンセルできません。",
    flags: [64],
  }));
});

test("rate limited result shows next available Discord timestamp", async () => {
  const service = {
    confirm: jest.fn().mockResolvedValue({
      action: "rate_limited",
      requestId: "req-1",
      retryAfterMs: 60000,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const interaction = createButtonInteraction({ action: "confirm" });
  jest.spyOn(Date, "now").mockReturnValue(1000000);

  await handler.handleInteraction(interaction);

  expect(interaction.message.edit).toHaveBeenCalledWith(expect.objectContaining({
    content: "画像生成の上限に達しました。次は <t:1060:t> 以降に使えます。",
  }));
  Date.now.mockRestore();
});

test("completionPromise rate limited result shows next available Discord timestamp", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    confirm: jest.fn().mockResolvedValue({
      action: "running",
      requestId: "req-1",
      completionPromise,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const interaction = createButtonInteraction({ action: "confirm" });
  jest.spyOn(Date, "now").mockReturnValue(1000000);

  await handler.handleInteraction(interaction);
  resolveCompletion({
    action: "rate_limited",
    requestId: "req-1",
    retryAfterMs: 60000,
  });
  await flush();

  expect(interaction.message.edit).toHaveBeenLastCalledWith(expect.objectContaining({
    content: "画像生成の上限に達しました。次は <t:1060:t> 以降に使えます。",
  }));
  Date.now.mockRestore();
});

test("slash command runs without confirmation and uses the same image delivery path", async () => {
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const service = {
    runSlashCommand: jest.fn().mockResolvedValue({
      action: "running",
      requestId: "req-slash",
      completionPromise,
    }),
  };
  const handler = createImageGenerationDiscordHandler({ service });
  const interaction = createSlashInteraction();

  await handler.handleInteraction(interaction);

  expect(interaction.deferReply).toHaveBeenCalled();
  expect(service.runSlashCommand).toHaveBeenCalledWith(expect.objectContaining({
    prompt: "画像生成して",
    purpose: "thumbnail",
    abstractModel: "standard",
    userId: "user-1",
  }));
  expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: "画像生成を受け付けました。少し待ってください。",
    components: [],
  }));

  resolveCompletion({
    action: "completed",
    requestId: "req-slash",
    image: { base64: pngBase64, mimeType: "image/png" },
  });
  await flush();

  expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: "",
    files: [expect.any(AttachmentBuilder)],
  }));
  expect(interaction.reply).not.toHaveBeenCalled();
});
