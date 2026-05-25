const { buildImageGenerationPrompt } = require('../src/image-generation-prompt');

describe('image-generation-prompt', () => {
  it('builds a transient prompt separately from storable request defaults', () => {
    const result = buildImageGenerationPrompt({
      userText: '暖かい創作コミュニティの作業場を描いて',
      purpose: 'thumbnail',
      abstractModel: 'standard',
    });

    expect(result.transient_prompt).toContain('User request: 暖かい創作コミュニティの作業場を描いて');
    expect(result.transient_prompt).toContain('Purpose: thumbnail.');
    expect(result.transient_prompt).toContain('Text layout policy:');
    expect(result.prompt).toBeUndefined();
    expect(result.components).toBeUndefined();
    expect(result.transient_prompt_components).toMatchObject({
      purpose: 'thumbnail',
      style_hint: null,
    });
    expect(result.transient_prompt_components.user_request).toBeUndefined();
    expect(result.request_defaults).toEqual({
      provider: 'openai',
      model: 'gpt-image-1.5',
      quality: 'auto',
      abstract_model: 'standard',
      purpose: 'thumbnail',
      aspect_ratio: 'landscape',
      size: '1536x1024',
      return_format: 'base64',
    });
  });

  it('keeps style hint as an optional extension point', () => {
    const result = buildImageGenerationPrompt({
      userText: '待機画面を作って',
      purpose: 'waiting_screen',
      abstractModel: 'high_quality',
      styleHint: 'soft lighting',
    });

    expect(result.transient_prompt).toContain('Style hint: soft lighting');
    expect(result.transient_prompt_components.style_hint).toBe('soft lighting');
    expect(result.request_defaults).toMatchObject({
      quality: 'high',
      aspect_ratio: 'landscape',
      size: '1536x1024',
    });
  });
});
