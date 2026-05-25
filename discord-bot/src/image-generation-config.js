const DEFAULT_IMAGE_GENERATION_CONFIG = Object.freeze({
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

const ABSTRACT_MODEL_MAPPINGS = Object.freeze({
  fast: Object.freeze({
    provider: 'openai',
    model: 'gpt-image-1.5',
    quality: 'low',
  }),
  standard: Object.freeze({
    provider: 'openai',
    model: 'gpt-image-1.5',
    quality: 'auto',
  }),
  high_quality: Object.freeze({
    provider: 'openai',
    model: 'gpt-image-1.5',
    quality: 'high',
  }),
});

const PURPOSE_PRESETS = Object.freeze({
  thumbnail: Object.freeze({
    aspect_ratio: 'landscape',
    size: '1536x1024',
    description: '配信/YouTube/告知サムネ',
  }),
  waiting_screen: Object.freeze({
    aspect_ratio: 'landscape',
    size: '1536x1024',
    description: '配信待機画面',
  }),
  hp_visual: Object.freeze({
    aspect_ratio: 'landscape',
    size: '1536x1024',
    description: 'Webサイト用ビジュアル',
  }),
  announcement: Object.freeze({
    aspect_ratio: 'square',
    size: '1024x1024',
    description: '告知画像',
  }),
  member_intro: Object.freeze({
    aspect_ratio: 'portrait',
    size: '1024x1536',
    description: 'メンバー紹介',
  }),
  other: Object.freeze({
    aspect_ratio: 'square',
    size: '1024x1024',
    description: 'その他',
  }),
});

const IMAGE_PROVIDER_MODELS = Object.freeze({
  openai: Object.freeze({
    models: Object.freeze({
      'gpt-image-1.5': Object.freeze({
        supportedQualities: Object.freeze(['low', 'auto', 'high']),
        defaultReturnFormat: 'base64',
      }),
    }),
  }),
});

const ENV_KEYS = Object.freeze({
  enabled: 'DOKOBASHO_IMAGE_ENABLED',
  webhookUrl: 'DOKOBASHO_IMAGE_WEBHOOK_URL',
  webhookToken: 'DOKOBASHO_IMAGE_WEBHOOK_TOKEN',
  allowedChannelIds: 'DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS',
  allowAllChannels: 'DOKOBASHO_IMAGE_ALLOW_ALL_CHANNELS',
  disabledGuildIds: 'DOKOBASHO_IMAGE_DISABLED_GUILD_IDS',
  disabledUserIds: 'DOKOBASHO_IMAGE_DISABLED_USER_IDS',
  timeoutMs: 'DOKOBASHO_IMAGE_TIMEOUT_MS',
  intentConfidenceThreshold: 'DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD',
  confirmationTtlSeconds: 'DOKOBASHO_IMAGE_CONFIRMATION_TTL_SECONDS',
  userLimitPerHour: 'DOKOBASHO_IMAGE_USER_LIMIT_PER_HOUR',
  guildLimitPerDay: 'DOKOBASHO_IMAGE_GUILD_LIMIT_PER_DAY',
  guildConcurrency: 'DOKOBASHO_IMAGE_GUILD_CONCURRENCY',
  guildQueueSize: 'DOKOBASHO_IMAGE_GUILD_QUEUE_SIZE',
  queueTtlSeconds: 'DOKOBASHO_IMAGE_QUEUE_TTL_SECONDS',
});

const parseInteger = (env, key, defaultValue) => {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return defaultValue;
  }

  const value = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(value) || String(value) !== String(rawValue).trim() || value <= 0) {
    return defaultValue;
  }
  return value;
};

const parseConfidenceThreshold = (env, key, defaultValue) => {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return defaultValue;
  }

  const value = Number.parseFloat(String(rawValue));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return defaultValue;
  }
  return value;
};

const parseAllowedChannelIds = (value) => {
  if (!value || String(value).trim() === '') {
    return [];
  }

  return String(value)
    .split(',')
    .map((channelId) => channelId.trim())
    .filter(Boolean);
};

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
};

const parseImageGenerationConfig = (env = process.env) => ({
  enabled: parseBoolean(env[ENV_KEYS.enabled], DEFAULT_IMAGE_GENERATION_CONFIG.enabled),
  webhookUrl: env[ENV_KEYS.webhookUrl] || DEFAULT_IMAGE_GENERATION_CONFIG.webhookUrl,
  webhookToken: env[ENV_KEYS.webhookToken] || DEFAULT_IMAGE_GENERATION_CONFIG.webhookToken,
  allowedChannelIds: parseAllowedChannelIds(env[ENV_KEYS.allowedChannelIds]),
  allowAllChannels: parseBoolean(
    env[ENV_KEYS.allowAllChannels],
    DEFAULT_IMAGE_GENERATION_CONFIG.allowAllChannels
  ),
  disabledGuildIds: parseAllowedChannelIds(env[ENV_KEYS.disabledGuildIds]),
  disabledUserIds: parseAllowedChannelIds(env[ENV_KEYS.disabledUserIds]),
  timeoutMs: parseInteger(env, ENV_KEYS.timeoutMs, DEFAULT_IMAGE_GENERATION_CONFIG.timeoutMs),
  intentConfidenceThreshold: parseConfidenceThreshold(
    env,
    ENV_KEYS.intentConfidenceThreshold,
    DEFAULT_IMAGE_GENERATION_CONFIG.intentConfidenceThreshold
  ),
  confirmationTtlSeconds: parseInteger(
    env,
    ENV_KEYS.confirmationTtlSeconds,
    DEFAULT_IMAGE_GENERATION_CONFIG.confirmationTtlSeconds
  ),
  userLimitPerHour: parseInteger(
    env,
    ENV_KEYS.userLimitPerHour,
    DEFAULT_IMAGE_GENERATION_CONFIG.userLimitPerHour
  ),
  guildLimitPerDay: parseInteger(
    env,
    ENV_KEYS.guildLimitPerDay,
    DEFAULT_IMAGE_GENERATION_CONFIG.guildLimitPerDay
  ),
  guildConcurrency: parseInteger(
    env,
    ENV_KEYS.guildConcurrency,
    DEFAULT_IMAGE_GENERATION_CONFIG.guildConcurrency
  ),
  guildQueueSize: parseInteger(
    env,
    ENV_KEYS.guildQueueSize,
    DEFAULT_IMAGE_GENERATION_CONFIG.guildQueueSize
  ),
  queueTtlSeconds: parseInteger(
    env,
    ENV_KEYS.queueTtlSeconds,
    DEFAULT_IMAGE_GENERATION_CONFIG.queueTtlSeconds
  ),
});

const isImageGenerationChannelAllowed = (channelId, config) => {
  if (!config) return false;
  if (config.allowAllChannels) {
    return true;
  }
  if (!Array.isArray(config.allowedChannelIds) || config.allowedChannelIds.length === 0) {
    return false;
  }
  return config.allowedChannelIds.includes(String(channelId));
};

const isImageGenerationActorAllowed = ({ guildId, userId } = {}, config) => {
  if (!config) return false;
  if (Array.isArray(config.disabledGuildIds) && config.disabledGuildIds.includes(String(guildId))) {
    return false;
  }
  if (Array.isArray(config.disabledUserIds) && config.disabledUserIds.includes(String(userId))) {
    return false;
  }
  return true;
};

const resolveAbstractModel = (abstractModel = 'standard') => {
  const model = ABSTRACT_MODEL_MAPPINGS[abstractModel] ? abstractModel : 'standard';
  return {
    abstract_model: model,
    ...ABSTRACT_MODEL_MAPPINGS[model],
  };
};

const resolveImageProviderModel = (abstractModel = 'standard') => {
  const resolved = resolveAbstractModel(abstractModel);
  const provider = IMAGE_PROVIDER_MODELS[resolved.provider];
  const model = provider && provider.models[resolved.model];

  return {
    ...resolved,
    provider_capabilities: model
      ? {
          supportedQualities: [...model.supportedQualities],
          defaultReturnFormat: model.defaultReturnFormat,
        }
      : null,
  };
};

const resolvePurposePreset = (purpose = 'other') => {
  const preset = PURPOSE_PRESETS[purpose] ? purpose : 'other';
  return {
    purpose: preset,
    ...PURPOSE_PRESETS[preset],
  };
};

module.exports = {
  ABSTRACT_MODEL_MAPPINGS,
  DEFAULT_IMAGE_GENERATION_CONFIG,
  ENV_KEYS,
  PURPOSE_PRESETS,
  IMAGE_PROVIDER_MODELS,
  isImageGenerationActorAllowed,
  isImageGenerationChannelAllowed,
  parseImageGenerationConfig,
  resolveAbstractModel,
  resolveImageProviderModel,
  resolvePurposePreset,
};
