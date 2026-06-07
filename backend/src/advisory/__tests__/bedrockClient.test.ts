import { describe, it, expect } from 'vitest';
import {
  buildAdvisoryBody,
  extractText,
  estimateTokens,
  computeCostUsd,
  ADVISORY_MODEL_ID,
  ADVISORY_MAX_TOKENS,
} from '../bedrockClient.js';

describe('buildAdvisoryBody', () => {
  it('puts the system prompt in a CACHED block and volatile content in the user message', () => {
    const body = buildAdvisoryBody('SYSTEM PREAMBLE', 'chunks + chart + question') as {
      anthropic_version: string;
      max_tokens: number;
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.max_tokens).toBe(ADVISORY_MAX_TOKENS);
    expect(body.system[0].text).toBe('SYSTEM PREAMBLE');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0]).toEqual({ role: 'user', content: 'chunks + chart + question' });
  });
  it('honors a custom max_tokens (output cost cap)', () => {
    const body = buildAdvisoryBody('s', 'u', 500) as { max_tokens: number };
    expect(body.max_tokens).toBe(500);
  });
  it('never leaks volatile content into the cached system block', () => {
    const body = buildAdvisoryBody('STABLE PREAMBLE', 'CLM-123 veteran John Doe asked X') as {
      system: Array<{ text: string }>;
    };
    expect(body.system[0].text).toBe('STABLE PREAMBLE');
    expect(body.system[0].text).not.toContain('CLM-123');
  });
});

describe('extractText', () => {
  it('joins text blocks and ignores non-text', () => {
    expect(extractText({ content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }] })).toBe('Hello world');
  });
  it('returns empty string for no content', () => {
    expect(extractText({})).toBe('');
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('computeCostUsd', () => {
  it('prices input + output tokens (incl. cache tokens as input)', () => {
    // 1M input @ $15 + 1M output @ $75 = $90
    expect(computeCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(90);
    // cache-read tokens count as input
    expect(computeCostUsd({ cache_read_input_tokens: 1_000_000, output_tokens: 0 })).toBe(15);
  });
  it('is ~pennies for a typical question', () => {
    const c = computeCostUsd({ input_tokens: 3000, output_tokens: 600 });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(0.1); // < 10¢ per the cost target
  });
});

describe('model id', () => {
  it('is the live-available Opus 4.6 US inference profile', () => {
    expect(ADVISORY_MODEL_ID).toBe('us.anthropic.claude-opus-4-6-v1');
  });
});
