const {
  isImageGenerationActorAllowed,
  isImageGenerationChannelAllowed,
  parseImageGenerationConfig,
  resolveAbstractModel,
  resolveImageProviderModel,
  resolvePurposePreset,
} = require('../src/image-generation-config');

describe('image-generation-config', () => {
  it('parses image generation env with specification defaults', () => {
    const config = parseImageGenerationConfig({});

    expect(config).toEqual({
      enabled: false,
      webhookUrl: 'https://n8n.srv1212596.hstgr.cloud/webhook/dokobasho-image-generation',
      webhookToken: null,
      allowedChannelIds: [],
      allowAllChannels: false,
      disabledGuildIds: [],
      disabledUserIds: [],
      timeoutMs: 130000,
      intentConfidenceThreshold: 0.8,
      confirmationTtlSeconds: 180,
      userLimitPerHour: 5,
      guildLimitPerDay: 100,
      guildConcurrency: 2,
      guildQueueSize: 5,
      queueTtlSeconds: 900,
    });
  });

  it('parses configured values without reading dotenv files', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_WEBHOOK_URL: 'https://example.test/webhook',
      DOKOBASHO_IMAGE_WEBHOOK_TOKEN: 'secret-token',
      DOKOBASHO_IMAGE_ENABLED: 'true',
      DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS: ' 111,222, ,333 ',
      DOKOBASHO_IMAGE_ALLOW_ALL_CHANNELS: 'false',
      DOKOBASHO_IMAGE_DISABLED_GUILD_IDS: 'guild-1,guild-2',
      DOKOBASHO_IMAGE_DISABLED_USER_IDS: 'user-1,user-2',
      DOKOBASHO_IMAGE_TIMEOUT_MS: '1000',
      DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD: '0.9',
      DOKOBASHO_IMAGE_CONFIRMATION_TTL_SECONDS: '60',
      DOKOBASHO_IMAGE_USER_LIMIT_PER_HOUR: '2',
      DOKOBASHO_IMAGE_GUILD_LIMIT_PER_DAY: '30',
      DOKOBASHO_IMAGE_GUILD_CONCURRENCY: '1',
      DOKOBASHO_IMAGE_GUILD_QUEUE_SIZE: '4',
      DOKOBASHO_IMAGE_QUEUE_TTL_SECONDS: '120',
    });

    expect(config.webhookUrl).toBe('https://example.test/webhook');
    expect(config.webhookToken).toBe('secret-token');
    expect(config.enabled).toBe(true);
    expect(config.allowedChannelIds).toEqual(['111', '222', '333']);
    expect(config.allowAllChannels).toBe(false);
    expect(config.disabledGuildIds).toEqual(['guild-1', 'guild-2']);
    expect(config.disabledUserIds).toEqual(['user-1', 'user-2']);
    expect(config.timeoutMs).toBe(1000);
    expect(config.intentConfidenceThreshold).toBe(0.9);
    expect(config.confirmationTtlSeconds).toBe(60);
    expect(config.userLimitPerHour).toBe(2);
    expect(config.guildLimitPerDay).toBe(30);
    expect(config.guildConcurrency).toBe(1);
    expect(config.guildQueueSize).toBe(4);
    expect(config.queueTtlSeconds).toBe(120);
  });

  it('falls back to defaults for invalid numeric values', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_TIMEOUT_MS: '0',
      DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD: '1.5',
      DOKOBASHO_IMAGE_CONFIRMATION_TTL_SECONDS: '-1',
      DOKOBASHO_IMAGE_USER_LIMIT_PER_HOUR: '0',
      DOKOBASHO_IMAGE_GUILD_LIMIT_PER_DAY: 'not-a-number',
      DOKOBASHO_IMAGE_GUILD_CONCURRENCY: '1.5',
      DOKOBASHO_IMAGE_GUILD_QUEUE_SIZE: '0',
      DOKOBASHO_IMAGE_QUEUE_TTL_SECONDS: '-10',
    });

    expect(config.timeoutMs).toBe(130000);
    expect(config.intentConfidenceThreshold).toBe(0.8);
    expect(config.confirmationTtlSeconds).toBe(180);
    expect(config.userLimitPerHour).toBe(5);
    expect(config.guildLimitPerDay).toBe(100);
    expect(config.guildConcurrency).toBe(2);
    expect(config.guildQueueSize).toBe(5);
    expect(config.queueTtlSeconds).toBe(900);
  });

  it('accepts confidence threshold boundaries within 0..1', () => {
    expect(
      parseImageGenerationConfig({
        DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD: '0',
      }).intentConfidenceThreshold
    ).toBe(0);
    expect(
      parseImageGenerationConfig({
        DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD: '1',
      }).intentConfidenceThreshold
    ).toBe(1);
  });

  it('does not allow every channel when allowed channel list is empty by default', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS: '',
    });

    expect(isImageGenerationChannelAllowed('999', config)).toBe(false);
  });

  it('allows every channel only when explicitly configured', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_ALLOW_ALL_CHANNELS: 'true',
      DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS: '',
    });

    expect(isImageGenerationChannelAllowed('999', config)).toBe(true);
  });

  it('allows only configured channels when allowed channel list exists', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS: '111,222',
    });

    expect(isImageGenerationChannelAllowed('111', config)).toBe(true);
    expect(isImageGenerationChannelAllowed('333', config)).toBe(false);
  });

  it('blocks configured disabled guilds and users', () => {
    const config = parseImageGenerationConfig({
      DOKOBASHO_IMAGE_DISABLED_GUILD_IDS: 'guild-1',
      DOKOBASHO_IMAGE_DISABLED_USER_IDS: 'user-1',
    });

    expect(isImageGenerationActorAllowed({ guildId: 'guild-1', userId: 'user-2' }, config)).toBe(false);
    expect(isImageGenerationActorAllowed({ guildId: 'guild-2', userId: 'user-1' }, config)).toBe(false);
    expect(isImageGenerationActorAllowed({ guildId: 'guild-2', userId: 'user-2' }, config)).toBe(true);
  });

  it('resolves abstract model mappings', () => {
    expect(resolveAbstractModel('fast')).toEqual({
      abstract_model: 'fast',
      provider: 'openai',
      model: 'gpt-image-1.5',
      quality: 'low',
    });
    expect(resolveAbstractModel('high_quality')).toEqual({
      abstract_model: 'high_quality',
      provider: 'openai',
      model: 'gpt-image-1.5',
      quality: 'high',
    });
    expect(resolveAbstractModel('unknown').abstract_model).toBe('standard');
  });

  it('resolves provider capability separately from abstract model mappings', () => {
    expect(resolveImageProviderModel('standard')).toEqual({
      abstract_model: 'standard',
      provider: 'openai',
      model: 'gpt-image-1.5',
      quality: 'auto',
      provider_capabilities: {
        supportedQualities: ['low', 'auto', 'high'],
        defaultReturnFormat: 'base64',
      },
    });
  });

  it('resolves purpose preset mappings', () => {
    expect(resolvePurposePreset('thumbnail')).toMatchObject({
      purpose: 'thumbnail',
      aspect_ratio: 'landscape',
      size: '1536x1024',
    });
    expect(resolvePurposePreset('member_intro')).toMatchObject({
      purpose: 'member_intro',
      aspect_ratio: 'portrait',
      size: '1024x1536',
    });
    expect(resolvePurposePreset('unknown')).toMatchObject({
      purpose: 'other',
      aspect_ratio: 'square',
      size: '1024x1024',
    });
  });
});
