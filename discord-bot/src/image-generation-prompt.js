const { resolveImageProviderModel, resolvePurposePreset } = require('./image-generation-config');

const PURPOSE_INSTRUCTIONS = Object.freeze({
  thumbnail:
    'Use a strong landscape composition suitable for a streaming, YouTube, or announcement thumbnail.',
  waiting_screen:
    'Create a calm landscape composition suitable for a streaming waiting screen with readable negative space.',
  hp_visual:
    'Create a polished landscape key visual suitable for a website hero section.',
  announcement:
    'Create a square announcement image with a clear focal point and space for optional text overlays.',
  member_intro:
    'Create a portrait composition suitable for introducing a member or profile.',
  other:
    'Create a balanced square image suitable for sharing in Discord.',
});

const TEXT_MARGIN_POLICY =
  'If text is requested, keep generous blank margins and avoid relying on exact Japanese lettering.';

const sanitizeUserText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const buildImageGenerationPrompt = ({
  userText,
  purpose = 'other',
  abstractModel = 'standard',
  styleHint = null,
} = {}) => {
  const cleanedUserText = sanitizeUserText(userText);
  const purposePreset = resolvePurposePreset(purpose);
  const modelMapping = resolveImageProviderModel(abstractModel);
  const purposeInstruction = PURPOSE_INSTRUCTIONS[purposePreset.purpose] || PURPOSE_INSTRUCTIONS.other;

  const sections = [
    `User request: ${cleanedUserText}`,
    `Purpose: ${purposePreset.purpose}. ${purposeInstruction}`,
    `Text layout policy: ${TEXT_MARGIN_POLICY}`,
  ];

  if (styleHint) {
    sections.push(`Style hint: ${sanitizeUserText(styleHint)}`);
  }

  return {
    transient_prompt: sections.join('\n'),
    transient_prompt_components: {
      purpose: purposePreset.purpose,
      purpose_instruction: purposeInstruction,
      text_margin_policy: TEXT_MARGIN_POLICY,
      style_hint: styleHint ? sanitizeUserText(styleHint) : null,
    },
    request_defaults: {
      provider: modelMapping.provider,
      model: modelMapping.model,
      quality: modelMapping.quality,
      abstract_model: modelMapping.abstract_model,
      purpose: purposePreset.purpose,
      aspect_ratio: purposePreset.aspect_ratio,
      size: purposePreset.size,
      return_format: 'base64',
    },
  };
};

module.exports = {
  PURPOSE_INSTRUCTIONS,
  TEXT_MARGIN_POLICY,
  buildImageGenerationPrompt,
};
