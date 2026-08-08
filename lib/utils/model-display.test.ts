import { describe, expect, it } from 'vitest';

import { parseModelDisplay } from '@/lib/utils/model-display';

describe('parseModelDisplay', () => {
  it('formats deepseek ids with brand casing and V-suffix', () => {
    expect(parseModelDisplay('deepseek-v4-flash')).toEqual({
      provider: 'DeepSeek',
      model: 'DeepSeek V4 Flash',
    });
  });

  it('handles claude specially: Anthropic provider, dotted version tail', () => {
    expect(parseModelDisplay('claude-sonnet-4-5')).toEqual({
      provider: 'Anthropic',
      model: 'Claude Sonnet 4.5',
    });
    expect(parseModelDisplay('claude-opus-4-1')).toEqual({
      provider: 'Anthropic',
      model: 'Claude Opus 4.1',
    });
  });

  it('maps gpt/o-series to OpenAI', () => {
    expect(parseModelDisplay('gpt-4o')).toEqual({
      provider: 'OpenAI',
      model: 'GPT 4o',
    });
    expect(parseModelDisplay('o3-mini')).toEqual({
      provider: 'OpenAI',
      model: 'O3 Mini',
    });
  });

  it('maps gemini to Google', () => {
    expect(parseModelDisplay('gemini-3.1-pro')).toEqual({
      provider: 'Google',
      model: 'Gemini 3.1 Pro',
    });
  });

  it('uses the explicit provider segment when present', () => {
    expect(parseModelDisplay('glm-rikki/glm-5.2')).toEqual({
      provider: 'GLM Rikki',
      model: 'GLM 5.2',
    });
  });

  it('falls back to the brand itself as provider for known brands', () => {
    expect(parseModelDisplay('glm-5.2')).toEqual({
      provider: 'GLM',
      model: 'GLM 5.2',
    });
  });

  it('returns null provider for unknown brands and capitalizes words', () => {
    expect(parseModelDisplay('acme-turbo-2')).toEqual({
      provider: null,
      model: 'Acme Turbo 2',
    });
  });

  it('keeps numeric-looking tokens intact', () => {
    expect(parseModelDisplay('llama-3-70b')).toEqual({
      provider: 'Llama',
      model: 'Llama 3 70b',
    });
  });
});
