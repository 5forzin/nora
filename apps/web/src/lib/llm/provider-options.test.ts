import { describe, expect, it } from 'vitest';

import { providerEndpointAllowed, providerOptions } from './provider-options';

describe('Google request options', () => {
  it('bounds thinking for Gemini without adding unsupported options to OpenAI', () => {
    expect(providerOptions('google', 'gemini-3.8-flash')).toEqual({ reasoning_effort: 'low' });
    expect(providerOptions('google', 'gemini-2.5-flash')).toEqual({ reasoning_effort: 'none' });
    expect(providerOptions('openai', 'gpt-4.1-2025-04-14')).toEqual({});
  });

  it('rejects crossed provider endpoints before a credential can be sent', () => {
    const google = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    expect(providerEndpointAllowed('google', google)).toBe(true);
    expect(providerEndpointAllowed('openai', google)).toBe(false);
    expect(providerEndpointAllowed('openai', google.replace('.com/', '.com./'))).toBe(false);
    expect(providerEndpointAllowed('google', 'https://api.openai.com/v1')).toBe(false);
    expect(providerEndpointAllowed('google', google.replace('https:', 'http:'))).toBe(false);
    expect(providerEndpointAllowed('google', `${google}?key=unexpected`)).toBe(false);
    expect(providerEndpointAllowed('google', `${google}#unexpected`)).toBe(false);
    expect(providerEndpointAllowed('google', google.replace('.com/', '.com:8443/'))).toBe(false);
    expect(providerEndpointAllowed('google', google.replace('https://', 'https://user@'))).toBe(
      false,
    );
    expect(providerEndpointAllowed('openai', 'https://api.openai.com/v1')).toBe(true);
    expect(providerEndpointAllowed('openai', 'invalid')).toBe(false);
  });
});
