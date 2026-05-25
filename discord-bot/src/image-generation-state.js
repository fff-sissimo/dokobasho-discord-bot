const STATUS = Object.freeze({
  CONFIRMING: 'confirming',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  QUEUED: 'queued',
});

const SAFE_METADATA_KEYS = Object.freeze([
  'requested_by_label',
  'trigger_type',
  'purpose',
  'abstract_model',
  'provider',
  'model',
  'quality',
  'size',
  'accepted_or_rejected',
  'source',
]);

class ImageGenerationStateStore {
  constructor({ now = () => Date.now(), confirmationTtlMs = 180000, queueTtlMs = 900000 } = {}) {
    this.now = now;
    this.confirmationTtlMs = confirmationTtlMs;
    this.queueTtlMs = queueTtlMs;
    this.records = new Map();
    this.temporaryPrompts = new Map();
    this.userUsage = new Map();
    this.guildUsage = new Map();
    this.guildRunningCounts = new Map();
    this.guildQueues = new Map();
  }

  createConfirmation({
    requestId,
    originalMessageId,
    confirmationMessageId,
    guildId,
    channelId,
    userId,
    promptPayload,
    detectedPurpose,
    summary,
    confidence,
    abstractModel,
    metadata = {},
    now = null,
  }) {
    if (!requestId) {
      throw new Error('requestId is required');
    }
    if (this.records.has(requestId)) {
      return {
        ok: false,
        reason: 'already_exists',
        record: this.getRecord(requestId),
      };
    }

    const currentTime = this.resolveNow(now);
    const createdAt = new Date(currentTime).toISOString();
    const expiresAt = new Date(currentTime + this.confirmationTtlMs).toISOString();
    const record = {
      request_id: requestId,
      original_message_id: originalMessageId,
      confirmation_message_id: confirmationMessageId,
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
      expires_at: expiresAt,
      status: STATUS.CONFIRMING,
      detected_purpose: detectedPurpose,
      summary,
      confidence,
      abstract_model: abstractModel,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      completed_at: null,
      completed_discord_message_id: null,
      last_error_category: null,
      attempt_count: 0,
      metadata: this.sanitizeMetadata(metadata),
    };

    this.records.set(requestId, record);
    this.temporaryPrompts.set(requestId, {
      prompt_payload: promptPayload,
      expires_at: expiresAt,
    });
    return {
      ok: true,
      record: this.getRecord(requestId),
    };
  }

  getRecord(requestId) {
    const record = this.records.get(requestId);
    return record ? this.cloneRecord(record) : null;
  }

  setConfirmationMessageId(requestId, confirmationMessageId, now = null) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    record.confirmation_message_id = confirmationMessageId;
    record.updated_at = new Date(currentTime).toISOString();
    return { ok: true, record: this.cloneRecord(record) };
  }

  expireConfirmation(requestId, now = null) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status !== STATUS.CONFIRMING) {
      return { ok: false, reason: 'not_confirming', record: this.cloneRecord(record) };
    }
    return this.cancel(requestId, { reason: 'expired', now: currentTime });
  }

  confirm(requestId, userId) {
    return this.claimConfirming(requestId, { userId });
  }

  claimConfirming(requestId, options = {}) {
    const userId = typeof options === 'object' && options !== null ? options.userId : null;
    const currentTime =
      typeof options === 'object' && options !== null ? this.resolveNow(options.now) : this.resolveNow(options);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (userId && record.user_id !== userId) {
      return { ok: false, reason: 'forbidden', record: this.cloneRecord(record) };
    }
    if (record.status !== STATUS.CONFIRMING) {
      return { ok: false, reason: 'not_confirming', record: this.cloneRecord(record) };
    }
    if (this.isExpired(record, currentTime)) {
      this.cancel(requestId, { reason: 'expired', now: currentTime });
      return { ok: false, reason: 'expired' };
    }

    record.status = STATUS.RUNNING;
    record.started_at = new Date(currentTime).toISOString();
    record.updated_at = record.started_at;
    record.attempt_count += 1;
    const promptPayload = this.temporaryPrompts.get(requestId)?.prompt_payload;
    return {
      ok: true,
      promptPayload,
      record: this.cloneRecord(record),
    };
  }

  cancel(requestId, options = {}) {
    const reason = typeof options === 'string' ? options : options.reason || 'cancelled';
    const currentTime = this.resolveNow(typeof options === 'object' ? options.now : null);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (![STATUS.CONFIRMING, STATUS.QUEUED].includes(record.status)) {
      return { ok: false, reason: 'not_cancellable', record: this.cloneRecord(record) };
    }

    record.status = STATUS.CANCELLED;
    record.last_error_category = reason;
    record.updated_at = new Date(currentTime).toISOString();
    this.deleteTemporaryPrompt(requestId);
    return { ok: true, record: this.cloneRecord(record) };
  }

  markCompleted(requestId, { completedDiscordMessageId, now = null } = {}) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === STATUS.COMPLETED && record.completed_discord_message_id) {
      return { ok: false, reason: 'already_completed', record: this.cloneRecord(record) };
    }
    if (record.status !== STATUS.RUNNING) {
      return { ok: false, reason: 'invalid_status', record: this.cloneRecord(record) };
    }

    record.status = STATUS.COMPLETED;
    record.completed_at = new Date(currentTime).toISOString();
    record.updated_at = record.completed_at;
    record.completed_discord_message_id = completedDiscordMessageId || record.completed_discord_message_id;
    record.last_error_category = null;
    this.deleteTemporaryPrompt(requestId);
    return { ok: true, record: this.cloneRecord(record) };
  }

  markQueued(requestId, { now = null } = {}) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status !== STATUS.RUNNING) {
      return { ok: false, reason: 'invalid_status', record: this.cloneRecord(record) };
    }

    record.status = STATUS.QUEUED;
    record.updated_at = new Date(currentTime).toISOString();
    return { ok: true, record: this.cloneRecord(record) };
  }

  markPreExecutionRejected(requestId, { category, now = null } = {}) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (![STATUS.CONFIRMING, STATUS.RUNNING, STATUS.QUEUED].includes(record.status)) {
      return { ok: false, reason: 'invalid_status', record: this.cloneRecord(record) };
    }

    record.status = STATUS.CANCELLED;
    record.last_error_category = category || 'pre_execution_rejected';
    record.updated_at = new Date(currentTime).toISOString();
    this.deleteTemporaryPrompt(requestId);
    return { ok: true, record: this.cloneRecord(record) };
  }

  markRunning(requestId, { now = null } = {}) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (![STATUS.QUEUED, STATUS.RUNNING].includes(record.status)) {
      return { ok: false, reason: 'invalid_status', record: this.cloneRecord(record) };
    }

    record.status = STATUS.RUNNING;
    if (!record.started_at) record.started_at = new Date(currentTime).toISOString();
    record.updated_at = new Date(currentTime).toISOString();
    return { ok: true, record: this.cloneRecord(record) };
  }

  markFailed(requestId, { errorCategory, now = null } = {}) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status !== STATUS.RUNNING) {
      return { ok: false, reason: 'invalid_status', record: this.cloneRecord(record) };
    }

    record.status = STATUS.FAILED;
    record.completed_at = new Date(currentTime).toISOString();
    record.updated_at = record.completed_at;
    record.last_error_category = errorCategory || null;
    this.deleteTemporaryPrompt(requestId);
    return { ok: true, record: this.cloneRecord(record) };
  }

  incrementAttempt(requestId, now = null) {
    const currentTime = this.resolveNow(now);
    const record = this.records.get(requestId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status !== STATUS.RUNNING) return { ok: false, reason: 'not_running' };

    record.attempt_count += 1;
    record.updated_at = new Date(currentTime).toISOString();
    return { ok: true, record: this.cloneRecord(record) };
  }

  cleanupExpired(now = null) {
    const currentTime = this.resolveNow(now);
    const expired = [];
    for (const [requestId, record] of this.records.entries()) {
      if (record.status === STATUS.CONFIRMING && this.isExpired(record, currentTime)) {
        this.cancel(requestId, { reason: 'expired', now: currentTime });
        expired.push(requestId);
      }
    }
    this.cleanupExpiredTemporaryPrompts(currentTime);
    this.cleanupExpiredQueueItems(null, currentTime);
    return expired;
  }

  incrementUserUsage(userId, windowKey, amount = 1) {
    return this.incrementUsage(this.userUsage, `${userId}:${windowKey}`, amount);
  }

  incrementGuildUsage(guildId, windowKey, amount = 1) {
    return this.incrementUsage(this.guildUsage, `${guildId}:${windowKey}`, amount);
  }

  getUserUsage(userId, windowKey) {
    return this.userUsage.get(`${userId}:${windowKey}`) || 0;
  }

  getGuildUsage(guildId, windowKey) {
    return this.guildUsage.get(`${guildId}:${windowKey}`) || 0;
  }

  acquireGuildSlot(guildId, limit) {
    const current = this.guildRunningCounts.get(guildId) || 0;
    if (current >= limit) return { ok: false, running: current };
    this.guildRunningCounts.set(guildId, current + 1);
    return { ok: true, running: current + 1 };
  }

  releaseGuildSlot(guildId) {
    const current = this.guildRunningCounts.get(guildId) || 0;
    const next = Math.max(0, current - 1);
    this.guildRunningCounts.set(guildId, next);
    return next;
  }

  enqueueGuildJob(guildId, requestId, maxSize, now = null) {
    const currentTime = this.resolveNow(now);
    const queue = this.guildQueues.get(guildId) || [];
    this.cleanupExpiredQueueItems(guildId, currentTime);
    const freshQueue = this.guildQueues.get(guildId) || queue;
    if (freshQueue.length >= maxSize) {
      return { ok: false, reason: 'queue_full', size: freshQueue.length };
    }

    const item = {
      request_id: requestId,
      enqueued_at: new Date(currentTime).toISOString(),
      expires_at: new Date(currentTime + this.queueTtlMs).toISOString(),
    };
    freshQueue.push(item);
    this.guildQueues.set(guildId, freshQueue);
    return { ok: true, position: freshQueue.length, item: { ...item } };
  }

  dequeueGuildJob(guildId) {
    this.cleanupExpiredQueueItems(guildId);
    const queue = this.guildQueues.get(guildId) || [];
    const item = queue.shift() || null;
    this.guildQueues.set(guildId, queue);
    return item ? { ...item } : null;
  }

  getGuildQueue(guildId) {
    this.cleanupExpiredQueueItems(guildId);
    return (this.guildQueues.get(guildId) || []).map((item) => ({ ...item }));
  }

  getTemporaryPrompt(requestId) {
    const temporaryPrompt = this.temporaryPrompts.get(requestId);
    return temporaryPrompt ? this.cloneRecord(temporaryPrompt) : null;
  }

  deleteTemporaryPrompt(requestId) {
    this.temporaryPrompts.delete(requestId);
  }

  incrementUsage(map, key, amount) {
    const next = (map.get(key) || 0) + amount;
    map.set(key, next);
    return next;
  }

  sanitizeMetadata(metadata = {}) {
    const safe = {};
    for (const key of SAFE_METADATA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        safe[key] = metadata[key];
      }
    }
    return safe;
  }

  isExpired(record, now = null) {
    return Date.parse(record.expires_at) <= this.resolveNow(now);
  }

  cleanupExpiredTemporaryPrompts(now = null) {
    const currentTime = this.resolveNow(now);
    for (const [requestId, temporaryPrompt] of this.temporaryPrompts.entries()) {
      if (Date.parse(temporaryPrompt.expires_at) <= currentTime) {
        this.deleteTemporaryPrompt(requestId);
      }
    }
  }

  cleanupExpiredQueueItems(guildId = null, now = null) {
    const currentTime = this.resolveNow(now);
    const guildIds = guildId ? [guildId] : Array.from(this.guildQueues.keys());
    for (const id of guildIds) {
      const queue = this.guildQueues.get(id) || [];
      const freshQueue = queue.filter((item) => Date.parse(item.expires_at) > currentTime);
      this.guildQueues.set(id, freshQueue);
    }
  }

  resolveNow(now = null) {
    if (now === null || now === undefined) return this.now();
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'string') return Date.parse(now);
    return now;
  }

  cloneRecord(record) {
    return JSON.parse(JSON.stringify(record));
  }
}

module.exports = {
  ImageGenerationStateStore,
  SAFE_METADATA_KEYS,
  STATUS,
};
