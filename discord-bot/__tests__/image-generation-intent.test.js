const {
  createImageGenerationIntentDetector,
  detectImageGenerationIntent,
} = require('../src/image-generation-intent');

describe('image-generation-intent', () => {
  it('detects a clear Japanese image generation request', () => {
    const result = detectImageGenerationIntent(
      '配信用のサムネ画像を生成して。暖かい創作コミュニティの作業場にして',
      { threshold: 0.8 }
    );

    expect(result).toMatchObject({
      is_image_request: true,
      purpose: 'thumbnail',
      abstract_model: 'standard',
      needs_confirmation: true,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.prompt_seed).toContain('サムネ画像');
  });

  it('detects a clear English image generation request', () => {
    const result = detectImageGenerationIntent(
      'Please generate an image for a website hero visual with a quiet workspace.',
      { threshold: 0.8 }
    );

    expect(result.is_image_request).toBe(true);
    expect(result.purpose).toBe('hp_visual');
    expect(result.needs_confirmation).toBe(true);
  });

  it('does not detect an ambiguous atmosphere comment as an image request', () => {
    const result = detectImageGenerationIntent('こういう雰囲気いいよね', { threshold: 0.8 });

    expect(result).toMatchObject({
      is_image_request: false,
      needs_confirmation: false,
      prompt_seed: '',
    });
    expect(result.confidence).toBeLessThan(0.8);
  });

  it('requires confidence to meet the configured threshold', () => {
    const result = detectImageGenerationIntent('イラストを作ってください', { threshold: 0.95 });

    expect(result.is_image_request).toBe(false);
    expect(result.needs_confirmation).toBe(false);
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('estimates model and purpose from wording', () => {
    const result = detectImageGenerationIntent(
      'メンバー紹介画像を高品質で作ってください。明るいプロフィール用。',
      { threshold: 0.8 }
    );

    expect(result.is_image_request).toBe(true);
    expect(result.purpose).toBe('member_intro');
    expect(result.abstract_model).toBe('high_quality');
  });

  it('allows a later LLM detector to be injected behind a stable API', async () => {
    const detector = jest.fn().mockResolvedValue({
      is_image_request: true,
      confidence: 0.88,
      purpose: 'announcement',
      summary: 'イベント告知',
      abstract_model: 'high_quality',
      prompt_seed: 'イベント告知画像',
      needs_confirmation: true,
    });
    const intentDetector = createImageGenerationIntentDetector({ detector, threshold: 0.8 });

    const result = await intentDetector.detect('LLM側で解釈する本文', { guildId: 'guild-1' });

    expect(detector).toHaveBeenCalledWith(
      'LLM側で解釈する本文',
      expect.objectContaining({
        guildId: 'guild-1',
        threshold: 0.8,
        intentConfidenceThreshold: 0.8,
      })
    );
    expect(result).toMatchObject({
      is_image_request: true,
      purpose: 'announcement',
      abstract_model: 'high_quality',
      needs_confirmation: true,
    });
  });

  it('normalizes injected detector results through the configured threshold', async () => {
    const intentDetector = createImageGenerationIntentDetector({
      detector: jest.fn().mockResolvedValue({
        is_image_request: true,
        confidence: 0.7,
        purpose: 'thumbnail',
        summary: '低信頼度',
        abstract_model: 'standard',
        prompt_seed: '低信頼度',
      }),
      threshold: 0.8,
    });

    const result = await intentDetector.detect('画像を作って');

    expect(result).toMatchObject({
      is_image_request: false,
      needs_confirmation: false,
      prompt_seed: '',
    });
  });

  it('falls back to deterministic detection when injected detector fails', async () => {
    const intentDetector = createImageGenerationIntentDetector({
      detector: jest.fn().mockRejectedValue(new Error('llm unavailable')),
      threshold: 0.8,
    });

    const result = await intentDetector.detect('サムネ画像を生成して');

    expect(result.is_image_request).toBe(true);
    expect(result.purpose).toBe('thumbnail');
  });
});
