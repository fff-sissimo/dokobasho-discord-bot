const { ImageGenerationStateStore, STATUS } = require('../src/image-generation-state');

describe('image-generation-state', () => {
  const baseConfirmation = {
    requestId: 'req-1',
    originalMessageId: 'msg-1',
    confirmationMessageId: 'confirm-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    promptPayload: { prompt: 'secret prompt body' },
    detectedPurpose: 'thumbnail',
    summary: 'summary only',
    confidence: 0.91,
    abstractModel: 'standard',
  };

  it('creates confirmation records and stores prompt payload separately', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });

    const result = store.createConfirmation(baseConfirmation);
    const record = result.record;

    expect(result.ok).toBe(true);
    expect(record).toMatchObject({
      request_id: 'req-1',
      status: STATUS.CONFIRMING,
      detected_purpose: 'thumbnail',
      summary: 'summary only',
      confidence: 0.91,
    });
    expect(record.prompt_payload).toBeUndefined();
    expect(store.getTemporaryPrompt('req-1')).toMatchObject({
      prompt_payload: { prompt: 'secret prompt body' },
    });
    expect(record.expires_at).toBe('2026-05-25T00:03:00.000Z');
  });

  it('rejects duplicate request ids without overwriting existing state', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation(baseConfirmation);
    store.claimConfirming('req-1', { userId: 'user-1' });

    const duplicate = store.createConfirmation({
      ...baseConfirmation,
      promptPayload: { prompt: 'new prompt must not replace old one' },
      summary: 'new summary',
    });

    expect(duplicate).toMatchObject({
      ok: false,
      reason: 'already_exists',
      record: {
        status: STATUS.RUNNING,
        summary: 'summary only',
      },
    });
    expect(store.getTemporaryPrompt('req-1')).toMatchObject({
      prompt_payload: { prompt: 'secret prompt body' },
    });
  });

  it('atomically claims confirmation once and prevents double click', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation(baseConfirmation);

    const first = store.claimConfirming('req-1', {
      userId: 'user-1',
      now: Date.parse('2026-05-25T00:00:01Z'),
    });
    const second = store.claimConfirming('req-1', {
      userId: 'user-1',
      now: Date.parse('2026-05-25T00:00:02Z'),
    });

    expect(first).toMatchObject({
      ok: true,
      promptPayload: { prompt: 'secret prompt body' },
    });
    expect(first.record.status).toBe(STATUS.RUNNING);
    expect(first.record.started_at).toBe('2026-05-25T00:00:01.000Z');
    expect(second).toMatchObject({
      ok: false,
      reason: 'not_confirming',
    });
  });

  it('rejects confirmation from another user without changing the record', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation(baseConfirmation);

    const result = store.claimConfirming('req-1', {
      userId: 'user-2',
      now: Date.parse('2026-05-25T00:00:01Z'),
    });

    expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(store.getRecord('req-1').status).toBe(STATUS.CONFIRMING);
  });

  it('cancels expired confirmations and deletes prompt payload', () => {
    let current = Date.parse('2026-05-25T00:00:00Z');
    const store = new ImageGenerationStateStore({ now: () => current });
    store.createConfirmation(baseConfirmation);

    current = Date.parse('2026-05-25T00:03:01Z');
    const result = store.claimConfirming('req-1', '2026-05-25T00:03:01Z');
    const record = store.getRecord('req-1');

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(record.status).toBe(STATUS.CANCELLED);
    expect(record.prompt_payload).toBeUndefined();
    expect(store.getTemporaryPrompt('req-1')).toBeNull();
  });

  it('deletes prompt payload on completion, failure, and cancellation', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation(baseConfirmation);
    store.claimConfirming('req-1', { userId: 'user-1' });
    store.markCompleted('req-1', { completedDiscordMessageId: 'done-1' });

    expect(store.getRecord('req-1')).toMatchObject({
      status: STATUS.COMPLETED,
      completed_discord_message_id: 'done-1',
    });
    expect(store.getRecord('req-1').prompt_payload).toBeUndefined();
    expect(store.getTemporaryPrompt('req-1')).toBeNull();

    store.createConfirmation({ ...baseConfirmation, requestId: 'req-2' });
    store.claimConfirming('req-2', { userId: 'user-1' });
    store.markFailed('req-2', { errorCategory: 'upstream_unavailable' });
    expect(store.getRecord('req-2').prompt_payload).toBeUndefined();
    expect(store.getTemporaryPrompt('req-2')).toBeNull();
    expect(store.getRecord('req-2').last_error_category).toBe('upstream_unavailable');

    store.createConfirmation({ ...baseConfirmation, requestId: 'req-3' });
    store.cancel('req-3', 'user_cancelled');
    expect(store.getRecord('req-3').prompt_payload).toBeUndefined();
    expect(store.getTemporaryPrompt('req-3')).toBeNull();
    expect(store.getRecord('req-3').status).toBe(STATUS.CANCELLED);
  });

  it('allows completion and failure only from running state', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation(baseConfirmation);

    expect(store.markCompleted('req-1', { completedDiscordMessageId: 'late-1' })).toMatchObject({
      ok: false,
      reason: 'invalid_status',
      record: { status: STATUS.CONFIRMING },
    });
    expect(store.markFailed('req-1', { errorCategory: 'late_failure' })).toMatchObject({
      ok: false,
      reason: 'invalid_status',
      record: { status: STATUS.CONFIRMING },
    });

    store.claimConfirming('req-1', { userId: 'user-1' });
    expect(store.markCompleted('req-1', { completedDiscordMessageId: 'done-1' })).toMatchObject({
      ok: true,
      record: { status: STATUS.COMPLETED, completed_discord_message_id: 'done-1' },
    });
    expect(store.markCompleted('req-1', { completedDiscordMessageId: 'done-2' })).toMatchObject({
      ok: false,
      reason: 'already_completed',
      record: { completed_discord_message_id: 'done-1' },
    });

    store.createConfirmation({ ...baseConfirmation, requestId: 'req-cancelled' });
    store.cancel('req-cancelled', 'user_cancelled');
    expect(
      store.markCompleted('req-cancelled', { completedDiscordMessageId: 'late-after-cancel' })
    ).toMatchObject({
      ok: false,
      reason: 'invalid_status',
      record: { status: STATUS.CANCELLED },
    });
  });

  it('filters unsafe metadata fields with a whitelist', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    const result = store.createConfirmation({
      ...baseConfirmation,
      metadata: {
        requested_by_label: 'Hermes',
        trigger_type: 'natural_language',
        provider: 'openai',
        prompt: 'do not store',
        user_request: 'do not store',
        content: 'do not store',
        message: 'do not store',
        body: 'do not store',
        image_base64: 'do not store',
        base64: 'do not store',
        token: 'do not store',
        secret: 'do not store',
        raw_error: 'do not store',
        error: 'do not store',
      },
    });

    expect(result.record.metadata).toEqual({
      requested_by_label: 'Hermes',
      trigger_type: 'natural_language',
      provider: 'openai',
    });
  });

  it('keeps minimal metadata for future rate limit and queue operations', () => {
    let current = Date.parse('2026-05-25T00:00:00Z');
    const store = new ImageGenerationStateStore({ now: () => current, queueTtlMs: 1000 });

    expect(store.incrementUserUsage('user-1', '2026-05-25T00')).toBe(1);
    expect(store.incrementGuildUsage('guild-1', '2026-05-25')).toBe(1);
    expect(store.getUserUsage('user-1', '2026-05-25T00')).toBe(1);
    expect(store.getGuildUsage('guild-1', '2026-05-25')).toBe(1);

    expect(store.acquireGuildSlot('guild-1', 1)).toEqual({ ok: true, running: 1 });
    expect(store.acquireGuildSlot('guild-1', 1)).toEqual({ ok: false, running: 1 });
    expect(store.releaseGuildSlot('guild-1')).toBe(0);

    expect(store.enqueueGuildJob('guild-1', 'req-1', 2)).toMatchObject({ ok: true, position: 1 });
    expect(store.enqueueGuildJob('guild-1', 'req-2', 2)).toMatchObject({ ok: true, position: 2 });
    expect(store.enqueueGuildJob('guild-1', 'req-3', 2)).toMatchObject({
      ok: false,
      reason: 'queue_full',
    });
    expect(store.dequeueGuildJob('guild-1').request_id).toBe('req-1');

    current = Date.parse('2026-05-25T00:00:02Z');
    expect(store.getGuildQueue('guild-1')).toEqual([]);
  });

  it('records confirmation message id and expires confirming records', () => {
    const store = new ImageGenerationStateStore({ now: () => Date.parse('2026-05-25T00:00:00Z') });
    store.createConfirmation({ ...baseConfirmation, requestId: 'req-1' });

    expect(store.setConfirmationMessageId('req-1', 'confirm-message-1')).toMatchObject({
      ok: true,
      record: {
        confirmation_message_id: 'confirm-message-1',
        status: STATUS.CONFIRMING,
      },
    });
    expect(store.expireConfirmation('req-1')).toMatchObject({
      ok: true,
      record: {
        status: STATUS.CANCELLED,
        last_error_category: 'expired',
      },
    });
    expect(store.getTemporaryPrompt('req-1')).toBeNull();
  });
});
