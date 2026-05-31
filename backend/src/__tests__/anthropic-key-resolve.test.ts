import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAnthropicSecretString, resolveAnthropicApiKey } from '../services/letter-surgical-propose.js';

describe('parseAnthropicSecretString', () => {
  it('returns a raw pasted key as-is (trimmed)', () => {
    expect(parseAnthropicSecretString('  sk-ant-abc123  ')).toBe('sk-ant-abc123');
  });

  it('unwraps a JSON {apiKey} / {ANTHROPIC_API_KEY} wrapper', () => {
    expect(parseAnthropicSecretString('{"apiKey":"sk-ant-xyz"}')).toBe('sk-ant-xyz');
    expect(parseAnthropicSecretString('{"ANTHROPIC_API_KEY":"sk-ant-789"}')).toBe('sk-ant-789');
  });

  it('treats a non-JSON string starting oddly as the raw key (no throw)', () => {
    expect(parseAnthropicSecretString('sk-ant-{notjson')).toBe('sk-ant-{notjson');
  });

  it('throws on a blank secret', () => {
    expect(() => parseAnthropicSecretString('   ')).toThrow();
  });
});

describe('resolveAnthropicApiKey — env precedence', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevArn = process.env.API_ANTHROPIC_KEY_SECRET_ARN;
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.API_ANTHROPIC_KEY_SECRET_ARN; });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevArn === undefined) delete process.env.API_ANTHROPIC_KEY_SECRET_ARN; else process.env.API_ANTHROPIC_KEY_SECRET_ARN = prevArn;
  });

  it('uses a literal ANTHROPIC_API_KEY without touching Secrets Manager', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-local';
    await expect(resolveAnthropicApiKey()).resolves.toBe('sk-ant-local');
  });

  it('throws when neither the key nor the secret ARN is set', async () => {
    await expect(resolveAnthropicApiKey()).rejects.toThrow(/ANTHROPIC_API_KEY or API_ANTHROPIC_KEY_SECRET_ARN/);
  });
});
