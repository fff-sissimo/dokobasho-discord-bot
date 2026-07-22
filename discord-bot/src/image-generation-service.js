"use strict";

const { v4: uuidv4 } = require("uuid");
const {
  ABSTRACT_MODEL_MAPPINGS,
  DEFAULT_IMAGE_GENERATION_CONFIG,
  PURPOSE_PRESETS,
  isImageGenerationActorAllowed,
  isImageGenerationChannelAllowed,
} = require("./image-generation-config");
const { buildImageGenerationPrompt } = require("./image-generation-prompt");
const { ImageGenerationStateStore, STATUS } = require("./image-generation-state");
const { createImageGenerationQueue } = require("./image-generation-queue");
const { createImageGenerationRateLimiter } = require("./image-generation-rate-limit");
const { createImageGenerationN8nClient } = require("./image-generation-n8n-client");

const createRequestId = () => `dokobasho-img-${uuidv4()}`;

const callIntentDetector = async (intentDetector, text, context) => {
  if (!intentDetector) return null;
  if (typeof intentDetector.detect === "function") return intentDetector.detect(text, context);
  if (typeof intentDetector === "function") return intentDetector(text, context);
  throw new Error("intentDetector must be a function or expose detect(text, context).");
};

const safeUserLabel = (label) => String(label || "").slice(0, 80);

const createImageGenerationService = ({
  config = DEFAULT_IMAGE_GENERATION_CONFIG,
  stateStore = new ImageGenerationStateStore({
    confirmationTtlMs: (config.confirmationTtlSeconds || 180) * 1000,
    queueTtlMs: (config.queueTtlSeconds || 900) * 1000,
  }),
  intentDetector,
  n8nClient = createImageGenerationN8nClient({
    webhookUrl: config.webhookUrl,
    token: config.webhookToken,
    timeoutMs: config.timeoutMs,
  }),
  rateLimiter = createImageGenerationRateLimiter({
    userLimitPerHour: config.userLimitPerHour,
    guildLimitPerDay: config.guildLimitPerDay,
  }),
  queue = createImageGenerationQueue({
    concurrency: config.guildConcurrency,
    queueSize: config.guildQueueSize,
    ttlMs: (config.queueTtlSeconds || 900) * 1000,
  }),
  requestIdFactory = createRequestId,
  now = () => Date.now(),
} = {}) => {
  const rateLeases = new Map();
  const queuedJobs = new Map();

  const createPromptPayload = ({ text, purpose, abstractModel }) => buildImageGenerationPrompt({
    userText: text,
    purpose,
    abstractModel,
  });

  const getAvailabilityRejection = ({ guildId, channelId, userId } = {}) => {
    if (config.enabled === false) return "disabled";
    if (!isImageGenerationActorAllowed({ guildId, userId }, config)) return "actor_disabled";
    if (!isImageGenerationChannelAllowed(channelId, config)) return "channel_not_allowed";
    return null;
  };

  const createConfirmationRecord = ({
    requestId,
    context,
    promptPayload,
    intent,
    triggerType,
  }) => stateStore.createConfirmation({
    requestId,
    originalMessageId: context.messageId || null,
    confirmationMessageId: context.confirmationMessageId || null,
    guildId: context.guildId,
    channelId: context.channelId,
    userId: context.userId,
    promptPayload,
    detectedPurpose: intent.purpose,
    summary: intent.summary,
    confidence: intent.confidence,
    abstractModel: intent.abstract_model,
    metadata: {
      source: "hermes-discord",
      requested_by_label: safeUserLabel(context.requestedByLabel),
      trigger_type: triggerType,
      purpose: intent.purpose,
      abstract_model: intent.abstract_model,
      provider: promptPayload.request_defaults.provider,
      model: promptPayload.request_defaults.model,
      quality: promptPayload.request_defaults.quality,
      size: promptPayload.request_defaults.size,
    },
    now: now(),
  });

  const prepareNaturalLanguageCandidate = async ({
    text,
    messageId,
    guildId,
    channelId,
    userId,
    requestedByLabel,
  } = {}) => {
    const rejection = getAvailabilityRejection({ guildId, channelId, userId });
    if (rejection) {
      return {
        action: "noop",
        reason: rejection,
        n8nCalled: false,
      };
    }

    const intent = await callIntentDetector(intentDetector, text, {
      guildId,
      channelId,
      userId,
      messageId,
      threshold: config.intentConfidenceThreshold,
    });

    if (!intent || !intent.is_image_request) {
      return {
        action: "noop",
        reason: "intent_not_detected",
        n8nCalled: false,
      };
    }

    const requestId = requestIdFactory();
    const promptPayload = createPromptPayload({
      text,
      purpose: intent.purpose,
      abstractModel: intent.abstract_model,
    });
    const created = createConfirmationRecord({
      requestId,
      context: { messageId, guildId, channelId, userId, requestedByLabel },
      promptPayload,
      intent,
      triggerType: "natural_language",
    });
    if (!created.ok) {
      return {
        action: "error",
        requestId,
        status: created.record && created.record.status,
        errorCategory: "duplicate_request",
      };
    }

    return {
      action: "confirm",
      requestId,
      status: STATUS.CONFIRMING,
      purpose: intent.purpose,
      summary: intent.summary,
      confidence: intent.confidence,
      abstractModel: intent.abstract_model,
      expiresAt: created.record.expires_at,
    };
  };

  const runSlashCommand = async ({
    prompt,
    purpose = "other",
    abstractModel = "standard",
    messageId = null,
    guildId,
    channelId,
    userId,
    requestedByLabel,
  } = {}) => {
    const requestId = requestIdFactory();
    const rejection = getAvailabilityRejection({ guildId, channelId, userId });
    if (rejection) {
      return {
        action: "rejected",
        requestId,
        status: null,
        errorCategory: rejection === "disabled" ? "credential_error" : rejection,
      };
    }
    if (!PURPOSE_PRESETS[purpose] || !ABSTRACT_MODEL_MAPPINGS[abstractModel]) {
      return {
        action: "rejected",
        requestId,
        status: null,
        errorCategory: "invalid_request",
      };
    }

    const intent = {
      purpose,
      summary: "",
      confidence: 1,
      abstract_model: abstractModel,
    };
    const promptPayload = createPromptPayload({ text: prompt, purpose, abstractModel });
    const created = createConfirmationRecord({
      requestId,
      context: { messageId, guildId, channelId, userId, requestedByLabel },
      promptPayload,
      intent,
      triggerType: "slash_command",
    });
    if (!created.ok) {
      return {
        action: "error",
        requestId,
        errorCategory: "duplicate_request",
      };
    }
    const claimed = stateStore.claimConfirming(requestId, { userId, now: now() });
    return submitClaimedRequest(claimed);
  };

  const confirm = async ({ requestId, userId } = {}) => {
    const claimed = stateStore.claimConfirming(requestId, { userId, now: now() });
    if (!claimed.ok) {
      return {
        action: "rejected",
        requestId,
        status: claimed.record && claimed.record.status,
        reason: claimed.reason,
      };
    }
    return submitClaimedRequest(claimed);
  };

  const cancel = ({ requestId, userId } = {}) => {
    const record = stateStore.getRecord(requestId);
    if (!record) {
      return { action: "rejected", requestId, reason: "not_found" };
    }
    if (record.user_id !== userId) {
      return { action: "rejected", requestId, status: record.status, reason: "forbidden" };
    }
    let refunded = false;
    if (record.status === STATUS.QUEUED) {
      const queued = queuedJobs.get(requestId);
      const cancelled = queued && queued.cancel ? queued.cancel({ userId }) : { cancelled: false, reason: "not_found" };
      if (!cancelled.cancelled) {
        return {
          action: "rejected",
          requestId,
          status: record.status,
          reason: cancelled.reason || "not_cancelled",
        };
      }
      queuedJobs.delete(requestId);
      refunded = refundRateLease(requestId);
    }

    const cancelled = stateStore.cancel(requestId, { reason: "user_cancelled", now: now() });
    if (!cancelled.ok) {
      return {
        action: "rejected",
        requestId,
        status: cancelled.record && cancelled.record.status,
        reason: cancelled.reason,
      };
    }
    return {
      action: "cancelled",
      requestId,
      status: STATUS.CANCELLED,
      refunded,
    };
  };

  const recordConfirmationMessage = ({ requestId, confirmationMessageId } = {}) => {
    const updated = stateStore.setConfirmationMessageId(requestId, confirmationMessageId, now());
    return {
      action: updated.ok ? "recorded" : "rejected",
      requestId,
      reason: updated.reason,
      status: updated.record && updated.record.status,
    };
  };

  const expireConfirmation = ({ requestId } = {}) => {
    const expired = stateStore.expireConfirmation(requestId, now());
    return {
      action: expired.ok ? "expired" : "rejected",
      requestId,
      reason: expired.reason,
      status: expired.record && expired.record.status,
    };
  };

  const submitClaimedRequest = async (claimed) => {
    const requestId = claimed.record.request_id;
    const record = claimed.record;
    const rateCheck = checkRateLimit(record);
    if (!rateCheck.allowed) {
      stateStore.markPreExecutionRejected(requestId, { category: "rate_limited", now: now() });
      return {
        action: "rate_limited",
        requestId,
        status: STATUS.CANCELLED,
        retryAfterMs: rateCheck.retryAfterMs,
        reasons: rateCheck.reasons,
      };
    }

    const run = async () => {
      stateStore.markRunning(requestId, { now: now() });
      const rate = consumeRateLimit(record, requestId);
      if (!rate.allowed) {
        stateStore.markPreExecutionRejected(requestId, { category: "rate_limited", now: now() });
        return {
          action: "rate_limited",
          requestId,
          status: STATUS.CANCELLED,
          retryAfterMs: rate.retryAfterMs,
          reasons: rate.reasons,
        };
      }
      if (rate.lease) rateLeases.set(requestId, rate);
      return executeN8nWithRetry({
        requestId,
        record: stateStore.getRecord(requestId),
        promptPayload: claimed.promptPayload,
      });
    };

    const enqueued = queue.enqueue({
      guildId: record.guild_id,
      jobId: requestId,
      run,
      metadata: {
        userId: record.user_id,
      },
    });

    if (!enqueued.accepted) {
      stateStore.markPreExecutionRejected(requestId, {
        category: enqueued.reason === "queue_full" ? "queue_full" : "queue_rejected",
        now: now(),
      });
      return {
        action: "rejected",
        requestId,
        status: STATUS.CANCELLED,
        errorCategory: enqueued.reason,
      };
    }

    const completionPromise = enqueued.promise
      .then((result) => {
        queuedJobs.delete(requestId);
        return result;
      })
      .catch((error) => handleQueuedJobRejected(requestId, error));

    if (enqueued.status === "queued") {
      stateStore.markQueued(requestId, { now: now() });
      queuedJobs.set(requestId, {
        cancel: enqueued.cancel,
        completionPromise,
      });
      return {
        action: "queued",
        requestId,
        status: STATUS.QUEUED,
        position: enqueued.position,
        completionPromise,
      };
    }

    return {
      action: "running",
      requestId,
      status: STATUS.RUNNING,
      completionPromise,
    };
  };

  const checkRateLimit = (record) => {
    if (!rateLimiter || typeof rateLimiter.check !== "function") {
      return { allowed: true, retryAfterMs: 0, reasons: [] };
    }
    return rateLimiter.check({
      userId: record.user_id,
      guildId: record.guild_id,
    });
  };

  const consumeRateLimit = (record, requestId) => {
    if (!rateLimiter || typeof rateLimiter.consume !== "function") {
      return { allowed: true };
    }
    return rateLimiter.consume({
      userId: record.user_id,
      guildId: record.guild_id,
      requestId,
    });
  };

  const refundRateLease = (requestId) => {
    const rate = rateLeases.get(requestId);
    if (!rate) return false;
    rateLeases.delete(requestId);
    if (typeof rate.refund === "function") return rate.refund();
    if (rateLimiter && typeof rateLimiter.refund === "function" && rate.lease) {
      return rateLimiter.refund(rate.lease);
    }
    return false;
  };

  const releaseRateLease = (requestId) => rateLeases.delete(requestId);

  const handleQueuedJobRejected = (requestId, error) => {
    queuedJobs.delete(requestId);
    const code = error && error.code ? error.code : "queue_rejected";
    stateStore.markPreExecutionRejected(requestId, {
      category: code,
      now: now(),
    });
    return {
      action: "cancelled",
      requestId,
      status: STATUS.CANCELLED,
      errorCategory: code,
    };
  };

  const executeN8nWithRetry = async ({ requestId, record, promptPayload }) => {
    const requestBody = buildN8nRequestBody({ requestId, record, promptPayload });
    let result;

    try {
      result = await n8nClient.generateImage(requestBody);
      if (result && !result.success && result.retryable) {
        stateStore.incrementAttempt(requestId, now());
        result = await n8nClient.generateImage(requestBody);
      }
    } catch (error) {
      refundRateLease(requestId);
      stateStore.markFailed(requestId, {
        errorCategory: error.category || "credential_error",
        now: now(),
      });
      return {
        action: "failed",
        requestId,
        status: STATUS.FAILED,
        errorCategory: error.category || "credential_error",
      };
    }

    if (result && result.success && result.image_base64) {
      releaseRateLease(requestId);
      stateStore.markCompleted(requestId, { now: now() });
      return {
        action: "completed",
        requestId,
        status: STATUS.COMPLETED,
        image: {
          base64: result.image_base64,
          mimeType: result.mime_type || "image/png",
        },
      };
    }

    const errorCategory =
      result && result.error && result.error.category ? result.error.category : "unknown";
    if (errorCategory === "invalid_request" || errorCategory === "auth_failed" || errorCategory === "credential_error") {
      refundRateLease(requestId);
    } else {
      releaseRateLease(requestId);
    }
    stateStore.markFailed(requestId, { errorCategory, now: now() });
    return {
      action: "failed",
      requestId,
      status: STATUS.FAILED,
      errorCategory,
    };
  };

  const buildN8nRequestBody = ({ requestId, record, promptPayload }) => {
    const defaults = promptPayload.request_defaults;
    return {
      request_id: requestId,
      provider: defaults.provider,
      model: defaults.model,
      prompt: promptPayload.transient_prompt,
      purpose: defaults.purpose,
      aspect_ratio: defaults.aspect_ratio,
      size: defaults.size,
      quality: defaults.quality,
      return_format: defaults.return_format,
      metadata: {
        source: "hermes-discord",
        guild_id: record.guild_id,
        channel_id: record.channel_id,
        user_id: record.user_id,
        requested_by_label: record.metadata.requested_by_label || "",
        trigger_type: record.metadata.trigger_type,
        purpose: defaults.purpose,
      },
    };
  };

  return {
    prepareNaturalLanguageCandidate,
    runSlashCommand,
    confirm,
    cancel,
    recordConfirmationMessage,
    expireConfirmation,
    buildN8nRequestBody,
  };
};

module.exports = {
  createImageGenerationService,
};
