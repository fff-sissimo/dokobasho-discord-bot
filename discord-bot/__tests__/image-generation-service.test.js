const { createImageGenerationService } = require("../src/image-generation-service");
const { ImageGenerationStateStore, STATUS } = require("../src/image-generation-state");

const baseConfig = {
  enabled: true,
  webhookUrl: "https://example.test/webhook",
  webhookToken: "webhook-secret",
  allowedChannelIds: ["allowed-channel"],
  allowAllChannels: false,
  disabledGuildIds: [],
  disabledUserIds: [],
  timeoutMs: 130000,
  intentConfidenceThreshold: 0.8,
  confirmationTtlSeconds: 180,
  userLimitPerHour: 5,
  guildLimitPerDay: 100,
  guildConcurrency: 1,
  guildQueueSize: 1,
  queueTtlSeconds: 900,
};

const imageIntent = {
  is_image_request: true,
  confidence: 0.91,
  purpose: "thumbnail",
  summary: "創作コミュニティのサムネ",
  abstract_model: "standard",
  needs_confirmation: true,
};

const createImmediateQueue = () => ({
  enqueue: jest.fn(({ run, jobId }) => ({
    accepted: true,
    jobId,
    status: "running",
    position: 0,
    promise: Promise.resolve().then(run),
  })),
});

const createQueuedQueue = () => {
  const cancel = jest.fn(() => ({ cancelled: true }));
  return {
    cancel,
    enqueue: jest.fn(({ jobId }) => ({
      accepted: true,
      jobId,
      status: "queued",
      position: 1,
      promise: new Promise(() => {}),
      cancel,
    })),
  };
};

const createRejectedQueuedQueue = (errorCode = "expired") => ({
  enqueue: jest.fn(({ jobId }) => ({
    accepted: true,
    jobId,
    status: "queued",
    position: 1,
    promise: Promise.reject(Object.assign(new Error(errorCode), { code: errorCode })),
    cancel: jest.fn(() => ({ cancelled: false, reason: "not_found" })),
  })),
});

const createFullQueue = () => ({
  enqueue: jest.fn(() => ({
    accepted: false,
    reason: "queue_full",
  })),
});

const createAllowRateLimiter = () => {
  const refund = jest.fn(() => true);
  const check = jest.fn(() => ({
    allowed: true,
    reasons: [],
    retryAfterMs: 0,
  }));
  const consume = jest.fn(() => ({
    allowed: true,
    reasons: [],
    retryAfterMs: 0,
    lease: { id: "lease-1" },
    refund,
  }));
  return {
    refund,
    check,
    consume,
  };
};

const createService = (overrides = {}) => {
  const stateStore = overrides.stateStore || new ImageGenerationStateStore({
    now: () => Date.parse("2026-05-25T00:00:00Z"),
  });
  const n8nClient = overrides.n8nClient || {
    generateImage: jest.fn().mockResolvedValue({
      success: true,
      image_base64: "base64-data",
      mime_type: "image/png",
    }),
  };
  const service = createImageGenerationService({
    config: { ...baseConfig, ...(overrides.config || {}) },
    stateStore,
    intentDetector: overrides.intentDetector || { detect: jest.fn().mockResolvedValue(imageIntent) },
    n8nClient,
    rateLimiter: overrides.rateLimiter || createAllowRateLimiter(),
    queue: overrides.queue || createImmediateQueue(),
    requestIdFactory: overrides.requestIdFactory || (() => "req-1"),
    now: () => Date.parse("2026-05-25T00:00:00Z"),
  });
  return { service, stateStore, n8nClient };
};

const prepare = (service, fields = {}) => service.prepareNaturalLanguageCandidate({
  text: "配信用のサムネ画像を生成して",
  messageId: "message-1",
  guildId: "guild-1",
  channelId: "allowed-channel",
  userId: "user-1",
  requestedByLabel: "Hermes User",
  ...fields,
});

describe("image-generation-service", () => {
  it("returns noop outside allowed channels and never calls detector or n8n", async () => {
    const intentDetector = { detect: jest.fn() };
    const n8nClient = { generateImage: jest.fn() };
    const { service } = createService({ intentDetector, n8nClient });

    await expect(prepare(service, { channelId: "blocked-channel" })).resolves.toEqual({
      action: "noop",
      reason: "channel_not_allowed",
      n8nCalled: false,
    });
    expect(intentDetector.detect).not.toHaveBeenCalled();
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });

  it("returns noop for disabled guilds/users before detector or n8n", async () => {
    const intentDetector = { detect: jest.fn() };
    const n8nClient = { generateImage: jest.fn() };
    const { service } = createService({
      intentDetector,
      n8nClient,
      config: {
        disabledGuildIds: ["guild-1"],
        disabledUserIds: ["user-2"],
      },
    });

    await expect(prepare(service)).resolves.toMatchObject({
      action: "noop",
      reason: "actor_disabled",
      n8nCalled: false,
    });
    expect(intentDetector.detect).not.toHaveBeenCalled();
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });

  it("rejects slash commands outside channel gate before n8n", async () => {
    const { service, n8nClient } = createService();

    await expect(service.runSlashCommand({
      prompt: "画像を作って",
      purpose: "thumbnail",
      abstractModel: "standard",
      guildId: "guild-1",
      channelId: "blocked-channel",
      userId: "user-1",
    })).resolves.toMatchObject({
      action: "rejected",
      errorCategory: "channel_not_allowed",
    });
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });

  it("creates a safe confirmation candidate without storing prompt in metadata", async () => {
    const { service, stateStore } = createService();

    const result = await prepare(service);

    expect(result).toMatchObject({
      action: "confirm",
      requestId: "req-1",
      status: STATUS.CONFIRMING,
      purpose: "thumbnail",
    });
    const record = stateStore.getRecord("req-1");
    expect(record.metadata).toMatchObject({
      source: "hermes-discord",
      trigger_type: "natural_language",
      purpose: "thumbnail",
    });
    expect(JSON.stringify(record.metadata)).not.toContain("サムネ画像");
  });

  it("allows only one confirm path to call n8n", async () => {
    const rateLimiter = createAllowRateLimiter();
    const { service, n8nClient } = createService({ rateLimiter });
    await prepare(service);

    const first = await service.confirm({ requestId: "req-1", userId: "user-1" });
    const second = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(first).toMatchObject({
      action: "running",
      requestId: "req-1",
      status: STATUS.RUNNING,
      completionPromise: expect.any(Promise),
    });
    await expect(first.completionPromise).resolves.toMatchObject({
      action: "completed",
      image: { base64: "base64-data", mimeType: "image/png" },
    });
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      action: "rejected",
      reason: "not_confirming",
    });
    expect(n8nClient.generateImage).toHaveBeenCalledTimes(1);
  });

  it("does not call n8n when rate limited", async () => {
    const rateLimiter = {
      check: jest.fn(() => ({
        allowed: false,
        retryAfterMs: 60000,
        reasons: ["user_rate_limited"],
      })),
      consume: jest.fn(),
    };
    const { service, n8nClient, stateStore } = createService({ rateLimiter });
    await prepare(service);

    const result = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(result).toMatchObject({
      action: "rate_limited",
      requestId: "req-1",
      status: STATUS.CANCELLED,
      retryAfterMs: 60000,
    });
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(stateStore.getTemporaryPrompt("req-1")).toBeNull();
  });

  it("does not call n8n or consume rate when queue is full", async () => {
    const rateLimiter = createAllowRateLimiter();
    const { service, n8nClient } = createService({
      rateLimiter,
      queue: createFullQueue(),
    });
    await prepare(service);

    const result = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(result).toMatchObject({
      action: "rejected",
      requestId: "req-1",
      status: STATUS.CANCELLED,
      errorCategory: "queue_full",
    });
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
    expect(rateLimiter.check).toHaveBeenCalledTimes(1);
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(rateLimiter.refund).not.toHaveBeenCalled();
  });

  it("retries retryable temporary failures once with the same request_id", async () => {
    const n8nClient = {
      generateImage: jest
        .fn()
        .mockResolvedValueOnce({
          success: false,
          retryable: true,
          error: { category: "upstream_unavailable" },
        })
        .mockResolvedValueOnce({
          success: true,
          image_base64: "base64-data",
          mime_type: "image/png",
        }),
    };
    const { service } = createService({ n8nClient });
    await prepare(service);

    const result = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(result).toMatchObject({
      action: "running",
      completionPromise: expect.any(Promise),
    });
    await expect(result.completionPromise).resolves.toMatchObject({ action: "completed" });
    expect(n8nClient.generateImage).toHaveBeenCalledTimes(2);
    expect(n8nClient.generateImage.mock.calls[0][0].request_id).toBe("req-1");
    expect(n8nClient.generateImage.mock.calls[1][0].request_id).toBe("req-1");
  });

  it("marks success without base64 as failed", async () => {
    const n8nClient = {
      generateImage: jest.fn().mockResolvedValue({
        success: true,
        mime_type: "image/png",
      }),
    };
    const { service } = createService({ n8nClient });
    await prepare(service);

    const result = await service.confirm({ requestId: "req-1", userId: "user-1" });
    expect(result).toMatchObject({
      action: "running",
      completionPromise: expect.any(Promise),
    });
    await expect(result.completionPromise).resolves.toMatchObject({
      action: "failed",
      requestId: "req-1",
      status: STATUS.FAILED,
    });
  });

  it("builds n8n body from transient prompt and minimal metadata", async () => {
    const { service, n8nClient } = createService();
    await prepare(service);
    const result = await service.confirm({ requestId: "req-1", userId: "user-1" });
    await result.completionPromise;

    const body = n8nClient.generateImage.mock.calls[0][0];
    expect(body).toMatchObject({
      request_id: "req-1",
      provider: "openai",
      model: "gpt-image-1.5",
      purpose: "thumbnail",
      aspect_ratio: "landscape",
      size: "1536x1024",
      quality: "auto",
      return_format: "base64",
      metadata: {
        source: "hermes-discord",
        guild_id: "guild-1",
        channel_id: "allowed-channel",
        user_id: "user-1",
        requested_by_label: "Hermes User",
        trigger_type: "natural_language",
        purpose: "thumbnail",
      },
    });
    expect(body.prompt).toContain("User request:");
    expect(JSON.stringify(body.metadata)).not.toContain("User request");
  });

  it("cancels queued jobs only for the owner without consuming rate", async () => {
    const rateLimiter = createAllowRateLimiter();
    const queue = createQueuedQueue();
    const { service, stateStore } = createService({ rateLimiter, queue });
    await prepare(service);
    const queued = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(queued).toMatchObject({
      action: "queued",
      requestId: "req-1",
      status: STATUS.QUEUED,
      position: 1,
    });
    expect(queued.completionPromise).toEqual(expect.any(Promise));
    expect(service.cancel({ requestId: "req-1", userId: "user-2" })).toMatchObject({
      action: "rejected",
      reason: "forbidden",
    });
    const cancelled = service.cancel({ requestId: "req-1", userId: "user-1" });
    expect(cancelled).toMatchObject({
      action: "cancelled",
      requestId: "req-1",
      status: STATUS.CANCELLED,
      refunded: false,
    });
    expect(queue.cancel).toHaveBeenCalledWith({ userId: "user-1" });
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(stateStore.getTemporaryPrompt("req-1")).toBeNull();
  });

  it("exposes queued completionPromise so the Discord layer can finish later", async () => {
    const completion = Promise.resolve({
      action: "completed",
      requestId: "req-1",
      status: STATUS.COMPLETED,
      image: { base64: "late-base64", mimeType: "image/png" },
    });
    const queue = {
      enqueue: jest.fn(({ jobId }) => ({
        accepted: true,
        jobId,
        status: "queued",
        position: 1,
        promise: completion,
        cancel: jest.fn(),
      })),
    };
    const { service } = createService({ queue });
    await prepare(service);

    const queued = await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(queued).toMatchObject({
      action: "queued",
      requestId: "req-1",
      status: STATUS.QUEUED,
      position: 1,
    });
    await expect(queued.completionPromise).resolves.toMatchObject({
      action: "completed",
      image: { base64: "late-base64" },
    });
  });

  it("cleans up state when a queued job expires before n8n is reached", async () => {
    const rateLimiter = createAllowRateLimiter();
    const { service, stateStore, n8nClient } = createService({
      rateLimiter,
      queue: createRejectedQueuedQueue("expired"),
    });
    await prepare(service);
    const queued = await service.confirm({ requestId: "req-1", userId: "user-1" });

    await expect(queued.completionPromise).resolves.toMatchObject({
      action: "cancelled",
      requestId: "req-1",
      status: STATUS.CANCELLED,
      errorCategory: "expired",
    });
    expect(stateStore.getRecord("req-1")).toMatchObject({
      status: STATUS.CANCELLED,
      last_error_category: "expired",
    });
    expect(stateStore.getTemporaryPrompt("req-1")).toBeNull();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });

  it("does not cancel state when queue cancel reports not_queued", async () => {
    const queue = {
      enqueue: jest.fn(({ jobId }) => ({
        accepted: true,
        jobId,
        status: "queued",
        position: 1,
        promise: new Promise(() => {}),
        cancel: jest.fn(() => ({ cancelled: false, reason: "not_queued" })),
      })),
    };
    const { service, stateStore } = createService({ queue });
    await prepare(service);
    await service.confirm({ requestId: "req-1", userId: "user-1" });

    expect(service.cancel({ requestId: "req-1", userId: "user-1" })).toMatchObject({
      action: "rejected",
      status: STATUS.QUEUED,
      reason: "not_queued",
    });
    expect(stateStore.getRecord("req-1").status).toBe(STATUS.QUEUED);
    expect(stateStore.getTemporaryPrompt("req-1")).not.toBeNull();
  });

  it("rejects slash commands with unknown purpose or abstract model before n8n", async () => {
    const { service, n8nClient } = createService();

    await expect(service.runSlashCommand({
      prompt: "画像を作って",
      purpose: "unknown",
      abstractModel: "standard",
      guildId: "guild-1",
      channelId: "allowed-channel",
      userId: "user-1",
    })).resolves.toMatchObject({
      action: "rejected",
      errorCategory: "invalid_request",
    });
    await expect(service.runSlashCommand({
      prompt: "画像を作って",
      purpose: "thumbnail",
      abstractModel: "unknown",
      guildId: "guild-1",
      channelId: "allowed-channel",
      userId: "user-1",
    })).resolves.toMatchObject({
      action: "rejected",
      errorCategory: "invalid_request",
    });
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });

  it("records confirmation message id and expires pending confirmation through service API", async () => {
    const { service, stateStore, n8nClient } = createService();
    await prepare(service);

    expect(service.recordConfirmationMessage({
      requestId: "req-1",
      confirmationMessageId: "confirm-message-1",
    })).toMatchObject({
      action: "recorded",
      requestId: "req-1",
    });
    expect(stateStore.getRecord("req-1")).toMatchObject({
      confirmation_message_id: "confirm-message-1",
      status: STATUS.CONFIRMING,
    });

    expect(service.expireConfirmation({ requestId: "req-1" })).toMatchObject({
      action: "expired",
      requestId: "req-1",
    });
    expect(stateStore.getRecord("req-1")).toMatchObject({
      status: STATUS.CANCELLED,
      last_error_category: "expired",
    });
    expect(stateStore.getTemporaryPrompt("req-1")).toBeNull();
    expect(n8nClient.generateImage).not.toHaveBeenCalled();
  });
});
