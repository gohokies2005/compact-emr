// Outreach-email drafter (2026-06-16) — the safety guards are the point: em/en dashes stripped, and
// ANY fee/money language is a HARD gate that falls back to a clean template (the $50-refund class
// must NEVER reach a veteran). The pure sanitizer + template are exhaustively pinned; the generator's
// fee-regenerate-then-template + error-fallback paths are pinned with Anthropic mocked.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));

import { sanitizeOutreachEmail, outreachTemplate, draftOutreachEmail, type OutreachInput } from '../services/outreach-email.js';

function aiText(text: string, stop: string = 'end_turn') {
  return { stop_reason: stop, content: [{ type: 'text', text }] };
}
const RECORDS: OutreachInput = { kind: 'contact_records', firstName: 'James', claimedCondition: 'Obstructive sleep apnea', missingFact: 'a 2019 sleep study report' };
const BRIDGE: OutreachInput = { kind: 'contact_alternative', firstName: 'James', claimedCondition: 'Obstructive sleep apnea', bridge: { intermediate_dx: 'Chronic rhinosinusitis', claimed: 'Obstructive sleep apnea', intermediate_presumptive_basis: '38 CFR 3.320' } };

describe('sanitizeOutreachEmail (mechanical guards)', () => {
  it('strips em/en dashes (→ comma or period) and flags the count', () => {
    const { text, flags } = sanitizeOutreachEmail('We reviewed it — and we need one item — today.');
    expect(text).not.toMatch(/[–—]/);
    expect(flags.find((f) => f.type === 'em_dash_stripped')).toMatchObject({ count: 2 });
  });
  it('HARD fee gate: any money/fee/refund word flags fee_language (block)', () => {
    for (const bad of ['There is a $50 fee.', 'we will refund your deposit', 'no cost to you', 'the price is fair', 'payment is due']) {
      expect(sanitizeOutreachEmail(bad).flags.some((f) => f.type === 'fee_language')).toBe(true);
    }
  });
  it('does NOT false-positive on clean copy', () => {
    const { flags } = sanitizeOutreachEmail('Hi James, thanks for trusting our team. Please upload your sleep study. Warm regards, The Flat Rate Nexus team');
    expect(flags).toHaveLength(0);
  });
  it('flags overpromise / scheduling / "I" voice for review (not block)', () => {
    expect(sanitizeOutreachEmail('This will be approved.').flags.some((f) => f.type === 'overpromise')).toBe(true);
    expect(sanitizeOutreachEmail('Let us schedule a call.').flags.some((f) => f.type === 'scheduling')).toBe(true);
    expect(sanitizeOutreachEmail('I reviewed your case.').flags.some((f) => f.type === 'voice')).toBe(true);
  });
});

describe('outreachTemplate (deterministic fallback — clean by construction)', () => {
  it('records template names the item, has no dash, no fee word, signs off as the team', () => {
    const t = outreachTemplate(RECORDS);
    expect(t).toContain('a 2019 sleep study report');
    expect(t).not.toMatch(/[–—]/);
    expect(sanitizeOutreachEmail(t).flags.filter((f) => f.type === 'fee_language')).toHaveLength(0);
    expect(t).toContain('The Flat Rate Nexus team');
  });
  it('alternative template names the bridge + claimed condition, no dash/fee', () => {
    const t = outreachTemplate(BRIDGE);
    expect(t).toContain('Chronic rhinosinusitis');
    expect(t).toContain('Obstructive sleep apnea');
    expect(t).not.toMatch(/[–—]/);
    expect(sanitizeOutreachEmail(t).flags.filter((f) => f.type === 'fee_language')).toHaveLength(0);
  });
});

describe('draftOutreachEmail (generator paths)', () => {
  beforeEach(() => { process.env['ANTHROPIC_API_KEY'] = 'sk-test'; create.mockReset(); });
  afterEach(() => { delete process.env['ANTHROPIC_API_KEY']; });

  it('clean AI output → source "ai", text passed through', async () => {
    create.mockResolvedValueOnce(aiText('Hi James, please upload your 2019 sleep study. Warm regards, The Flat Rate Nexus team'));
    const r = await draftOutreachEmail(RECORDS);
    expect(r.source).toBe('ai');
    expect(r.text).toContain('sleep study');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fee language in AI output → regenerate once → still fee → deterministic TEMPLATE (never ships fee)', async () => {
    create.mockResolvedValueOnce(aiText('Hi James, there is a $50 fee. Warm regards, The Flat Rate Nexus team'));
    create.mockResolvedValueOnce(aiText('Hi James, the refund will process. Warm regards, The Flat Rate Nexus team'));
    const r = await draftOutreachEmail(RECORDS);
    expect(create).toHaveBeenCalledTimes(2); // regenerated once
    expect(r.source).toBe('template');
    expect(sanitizeOutreachEmail(r.text).flags.filter((f) => f.type === 'fee_language')).toHaveLength(0); // clean
  });

  it('fee in first draft but clean on regenerate → source "ai", clean', async () => {
    create.mockResolvedValueOnce(aiText('Hi James, a $50 fee applies. Warm regards, The Flat Rate Nexus team'));
    create.mockResolvedValueOnce(aiText('Hi James, please upload your sleep study. Warm regards, The Flat Rate Nexus team'));
    const r = await draftOutreachEmail(RECORDS);
    expect(create).toHaveBeenCalledTimes(2);
    expect(r.source).toBe('ai');
  });

  it('API error → template (never blocks)', async () => {
    create.mockRejectedValueOnce(new Error('529 overloaded'));
    const r = await draftOutreachEmail(BRIDGE);
    expect(r.source).toBe('template');
    expect(r.text).toContain('Chronic rhinosinusitis');
  });

  it('truncated (max_tokens) → template', async () => {
    create.mockResolvedValueOnce(aiText('Hi James, we need...', 'max_tokens'));
    const r = await draftOutreachEmail(RECORDS);
    expect(r.source).toBe('template');
  });

  it('incomplete input (records kind, no missingFact) → template WITHOUT calling the model', async () => {
    const r = await draftOutreachEmail({ kind: 'contact_records', claimedCondition: 'OSA', missingFact: '' });
    expect(create).not.toHaveBeenCalled();
    expect(r.source).toBe('template');
  });
});
