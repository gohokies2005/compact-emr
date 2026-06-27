import { describe, it, expect } from 'vitest';
import {
  PAGE_LLM_VERSION,
  PAGE_TEXT_CHARS,
  SYSTEM_PROMPT,
  shouldUseLlmPicker,
} from '../doctor-pack-page-llm.js';

// Doctor-pack page-LLM picker 1.1.0 (2026-06-26): wider page window (600 -> 1200 chars so a
// value line below the page-type header survives) + a value-page clause in the system prompt so
// the picker keeps the page that carries the actual number/finding (AHI, FEV1/FVC, puretone,
// decision reason). Pure-unit guards only — selectPagesLlm itself hits Bedrock and is exercised
// in integration, not here.

describe('doctor-pack page-LLM 1.1.0 — version + window', () => {
  it('PAGE_LLM_VERSION is bumped to 1.1.0', () => {
    expect(PAGE_LLM_VERSION).toBe('page-llm-1.1.0');
  });

  it('PAGE_TEXT_CHARS is widened to 1200', () => {
    expect(PAGE_TEXT_CHARS).toBe(1200);
  });
});

describe('doctor-pack page-LLM 1.1.0 — value-page clause in the system prompt', () => {
  it('keeps the sleep-study AHI/RDI value page', () => {
    expect(SYSTEM_PROMPT).toContain('AHI/RDI');
  });

  it('keeps the audiogram puretone / Maryland CNC table page', () => {
    expect(SYSTEM_PROMPT).toContain('puretone-threshold');
    expect(SYSTEM_PROMPT).toContain('Maryland CNC');
  });

  it('keeps the PFT FEV1/FVC value page', () => {
    expect(SYSTEM_PROMPT).toContain('FEV1/FVC');
  });

  it('keeps the decision page that names the granted/denied condition AND its reason', () => {
    expect(SYSTEM_PROMPT).toMatch(/granted or denied condition AND its stated REASON/i);
  });
});

describe('doctor-pack page-LLM — shouldUseLlmPicker boundaries (unchanged)', () => {
  it('skips docs with fewer than 3 text pages', () => {
    expect(shouldUseLlmPicker(2)).toBe(false);
    expect(shouldUseLlmPicker(3)).toBe(true);
  });

  it('skips oversized docs (> 60 text pages) and falls back to regex', () => {
    expect(shouldUseLlmPicker(60)).toBe(true);
    expect(shouldUseLlmPicker(61)).toBe(false);
  });
});
