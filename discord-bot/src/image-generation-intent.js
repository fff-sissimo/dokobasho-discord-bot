const { DEFAULT_IMAGE_GENERATION_CONFIG, PURPOSE_PRESETS } = require('./image-generation-config');

const IMAGE_REQUEST_PATTERNS = [
  /画像.{0,16}(生成|作って|作成|描いて|出して|お願い|ほしい)/i,
  /(生成|作って|作成|描いて|出して).{0,16}(画像|イラスト|サムネ|ビジュアル|絵)/i,
  /(イラスト|サムネ|thumbnail|visual|banner|poster).{0,16}(作って|作成|生成|描いて|欲しい|ほしい)/i,
  /\b(generate|create|make|draw)\b.{0,32}\b(image|illustration|thumbnail|visual|banner|poster|picture)\b/i,
  /\b(image|illustration|thumbnail|visual|banner|poster|picture)\b.{0,32}\b(generate|create|make|draw)\b/i,
];

const AMBIGUOUS_PATTERNS = [
  /こういう雰囲気(いい|良い)よね/,
  /こんな感じ(いい|良い)よね/,
  /雰囲気(いい|良い)よね/,
  /\bnice vibe\b/i,
  /\bgood vibe\b/i,
];

const PURPOSE_PATTERNS = [
  ['thumbnail', /(サムネ|thumbnail|youtube|配信|告知サムネ)/i],
  ['waiting_screen', /(待機画面|waiting screen|starting soon|配信待機)/i],
  ['hp_visual', /(ホームページ|webサイト|website|hp|hero|キービジュアル)/i],
  ['announcement', /(告知|announcement|お知らせ|poster|ポスター)/i],
  ['member_intro', /(メンバー紹介|member intro|プロフィール|profile|紹介画像)/i],
];

const MODEL_PATTERNS = [
  ['high_quality', /(高品質|きれい|綺麗|精細|high quality|detailed|premium)/i],
  ['fast', /(速く|早く|ざっくり|quick|fast|draft)/i],
];

const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const estimatePurpose = (text) => {
  for (const [purpose, pattern] of PURPOSE_PATTERNS) {
    if (pattern.test(text)) return purpose;
  }
  return 'other';
};

const estimateAbstractModel = (text) => {
  for (const [model, pattern] of MODEL_PATTERNS) {
    if (pattern.test(text)) return model;
  }
  return 'standard';
};

const summarizePromptSeed = (text) => {
  const trimmed = normalizeText(text);
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
};

const normalizeIntentResult = (result, threshold) => {
  const confidence = Number.isFinite(result.confidence) ? result.confidence : 0;
  const purpose = PURPOSE_PRESETS[result.purpose] ? result.purpose : 'other';
  const abstractModel = result.abstract_model || 'standard';
  const isImageRequest = Boolean(result.is_image_request) && confidence >= threshold;
  const promptSeed = isImageRequest ? result.prompt_seed || result.summary || '' : '';

  return {
    is_image_request: isImageRequest,
    confidence,
    purpose,
    summary: isImageRequest ? result.summary || promptSeed : '',
    abstract_model: abstractModel,
    prompt_seed: promptSeed,
    needs_confirmation: isImageRequest,
  };
};

const deterministicImageGenerationIntentDetector = (text, options = {}) => {
  const threshold =
    options.intentConfidenceThreshold ??
    options.threshold ??
    DEFAULT_IMAGE_GENERATION_CONFIG.intentConfidenceThreshold;
  const normalizedText = normalizeText(text);
  const ambiguous = AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(normalizedText));
  const matched = IMAGE_REQUEST_PATTERNS.some((pattern) => pattern.test(normalizedText));

  let confidence = 0.12;
  if (matched) confidence = 0.86;
  if (matched && /(サムネ|thumbnail|画像生成|generate an image|create an image)/i.test(normalizedText)) {
    confidence = 0.92;
  }
  if (ambiguous) confidence = Math.min(confidence, 0.45);

  const purpose = estimatePurpose(normalizedText);
  const abstractModel = estimateAbstractModel(normalizedText);
  const isImageRequest = matched && !ambiguous && confidence >= threshold;
  const promptSeed = isImageRequest ? summarizePromptSeed(normalizedText) : '';

  return {
    is_image_request: isImageRequest,
    confidence,
    purpose: PURPOSE_PRESETS[purpose] ? purpose : 'other',
    summary: promptSeed || '',
    abstract_model: abstractModel,
    prompt_seed: promptSeed,
    needs_confirmation: isImageRequest,
  };
};

const detectImageGenerationIntent = deterministicImageGenerationIntentDetector;

const createImageGenerationIntentDetector = ({
  detector = null,
  fallbackDetector = deterministicImageGenerationIntentDetector,
  threshold = DEFAULT_IMAGE_GENERATION_CONFIG.intentConfidenceThreshold,
} = {}) => ({
  async detect(text, context = {}) {
    const options = {
      ...context,
      threshold,
      intentConfidenceThreshold: threshold,
    };

    if (detector) {
      try {
        const result = await detector(text, options);
        if (result) {
          return normalizeIntentResult(result, threshold);
        }
      } catch (error) {
        // Fallback keeps natural-language routing available when a pluggable detector fails.
      }
    }

    return normalizeIntentResult(await fallbackDetector(text, options), threshold);
  },
});

module.exports = {
  createImageGenerationIntentDetector,
  detectImageGenerationIntent,
  deterministicImageGenerationIntentDetector,
};
