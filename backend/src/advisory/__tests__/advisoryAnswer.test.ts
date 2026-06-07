import { describe, it, expect } from 'vitest';
import { stubRetrieve } from '../retrieveContract.js';
import {
  assembleUserContent,
  extractCitations,
  statusGuidance,
  answerQuestion,
  MAX_INPUT_TOKENS,
  type AnswerDeps,
} from '../advisoryAnswer.js';

const SLICE = { found: true, text: 'Claim: OSA\nSC: PTSD 70%', claimedCondition: 'OSA', conditions: ['OSA', 'PTSD'] };
const deps = (over: Partial<AnswerDeps> = {}): AnswerDeps => ({
  retrieve: stubRetrieve,
  buildChartSlice: async () => SLICE,
  invoke: async () => ({ text: 'GROUNDED ANSWER', costUsd: 0.03, stopReason: 'end_turn', usage: {} }),
  systemPrompt: 'SYSTEM PREAMBLE',
  ...over,
});

describe('stubRetrieve — exercises every status + both letter_citable values', () => {
  it('ok: two chunks, one letter-citable + one not', () => {
    const r = stubRetrieve({ question: 'is OSA secondary to PTSD viable?', caseConditions: ['OSA', 'PTSD'] });
    expect(r.status).toBe('ok');
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks.some((c) => c.letter_citable)).toBe(true);
    expect(r.chunks.some((c) => !c.letter_citable)).toBe(true); // the BVA aggregate
  });
  it('thin / empty / degraded branches', () => {
    expect(stubRetrieve({ question: '__thin__', caseConditions: [] }).status).toBe('thin');
    expect(stubRetrieve({ question: '__empty__', caseConditions: [] }).status).toBe('empty');
    expect(stubRetrieve({ question: '__degraded__', caseConditions: [] }).status).toBe('degraded');
  });
});

describe('assembleUserContent', () => {
  it('labels a not-letter-citable chunk as internal strategy + includes chart slice + question', () => {
    const r = stubRetrieve({ question: 'q', caseConditions: [] });
    const u = assembleUserContent(r.chunks, 'Claim: OSA', 'How does this do at the Board?');
    expect(u).toContain('REFERENCE MATERIAL');
    expect(u).toContain('INTERNAL STRATEGY — NOT letter-citable');
    expect(u).toContain('letter-citable) PMID:12345678');
    expect(u).toContain('PATIENT CHART SLICE');
    expect(u).toContain('QUESTION: How does this do at the Board?');
  });
});

describe('extractCitations + statusGuidance', () => {
  it('pulls citations with citability flags', () => {
    const r = stubRetrieve({ question: 'q', caseConditions: [] });
    const cits = extractCitations(r.chunks);
    expect(cits).toHaveLength(2);
    expect(cits.find((c) => c.source === 'sql')?.letter_citable).toBe(false);
  });
  it('gives a caveat for non-ok statuses, null for ok', () => {
    expect(statusGuidance('ok')).toBeNull();
    expect(statusGuidance('empty')).toMatch(/not grounded/i);
    expect(statusGuidance('thin')).toMatch(/preliminary/i);
    expect(statusGuidance('degraded')).toMatch(/unavailable/i);
  });
});

describe('answerQuestion (orchestration)', () => {
  it('happy path: grounded answer + citations + status', async () => {
    const r = await answerQuestion(deps(), { caseId: 'CLM-1', question: 'Is OSA secondary to PTSD viable?' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toBe('GROUNDED ANSWER');
      expect(r.citations).toHaveLength(2);
      expect(r.status).toBe('ok');
      expect(r.guidance).toBeNull();
      expect(r.costUsd).toBe(0.03);
    }
  });
  it('refuses an empty question', async () => {
    expect(await answerQuestion(deps(), { caseId: 'CLM-1', question: '   ' })).toEqual({ ok: false, reason: 'empty_question' });
  });
  it('case not found', async () => {
    const r = await answerQuestion(deps({ buildChartSlice: async () => null }), { caseId: 'X', question: 'hi' });
    expect(r).toEqual({ ok: false, reason: 'case_not_found' });
  });
  it('refuses over-budget before the paid call', async () => {
    const huge = 'x'.repeat((MAX_INPUT_TOKENS + 1000) * 4);
    const r = await answerQuestion(deps({ systemPrompt: huge }), { caseId: 'CLM-1', question: 'hi' });
    expect(r).toEqual({ ok: false, reason: 'over_budget' });
  });
  it('surfaces the empty-retrieval caveat', async () => {
    const r = await answerQuestion(deps(), { caseId: 'CLM-1', question: '__empty__ tell me' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('empty');
      expect(r.guidance).toMatch(/not grounded/i);
    }
  });
});
