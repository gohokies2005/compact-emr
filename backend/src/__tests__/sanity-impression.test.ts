// Sanity-impression service (2026-06-16) — the auto-fired "overall impression" gut-check. Pins the
// contract: forced-tool parse, the HIGH-BAR levels, and FAIL-OPEN by construction (incomplete input /
// truncation / API error / malformed → null, never a thrown failure that could block the pipeline).
import { beforeEach, describe, it, expect, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../services/letter-surgical-propose.js', () => ({ resolveAnthropicApiKey: vi.fn(async () => 'sk-test') }));

import { buildSanityImpression, type SanityContext } from '../services/sanity-impression.js';

function toolResp(impression: string, summary: string, missed = '', stop = 'tool_use') {
  return { stop_reason: stop, content: [{ type: 'tool_use', name: 'record_impression', input: { impression, summary, missed } }] };
}

const PRE: SanityContext = {
  stage: 'pre_draft',
  claimedCondition: 'Obstructive sleep apnea',
  theory: 'OSA secondary to service-connected PTSD',
  scConditions: ['PTSD'],
  keyFacts: ['OSA diagnosed on 2021 sleep study', 'PTSD service-connected 70%'],
  coverageNote: 'All pages read.',
};
const POST: SanityContext = {
  ...PRE,
  stage: 'post_draft',
  grade: 'A- (probative rubric)',
  draftText: 'I have reviewed the records of this veteran. '.repeat(20), // > 200 chars
};

beforeEach(() => { vi.clearAllMocks(); });

describe('buildSanityImpression', () => {
  it('parses a Clear pre-draft impression from the forced tool', async () => {
    create.mockResolvedValueOnce(toolResp('clear', 'Theory is sound: PTSD is a recognized cause of OSA and is service-connected.'));
    const r = await buildSanityImpression(PRE);
    expect(r).toMatchObject({ stage: 'pre_draft', impression: 'clear', missed: null });
    expect(r?.summary).toMatch(/recognized cause/);
  });

  it('surfaces a Concern with the missed phrase (the wrist→PTSD class)', async () => {
    create.mockResolvedValueOnce(toolResp('concern', 'The proposed mechanism runs backwards and is not medically supported.', 'wrist pain cannot cause PTSD'));
    const r = await buildSanityImpression({ ...PRE, theory: 'PTSD secondary to wrist pain' });
    expect(r?.impression).toBe('concern');
    expect(r?.missed).toBe('wrist pain cannot cause PTSD');
  });

  it('post-draft expands on the grade', async () => {
    create.mockResolvedValueOnce(toolResp('caution', 'Solid letter, but Section VI leans on a 2019 note that was flagged unread.', 'verify the 2019 sleep study is actually in the record'));
    const r = await buildSanityImpression(POST);
    expect(r).toMatchObject({ stage: 'post_draft', impression: 'caution' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('FAIL-OPEN: incomplete pre-draft (no claimed condition) → null, no API call', async () => {
    const r = await buildSanityImpression({ ...PRE, claimedCondition: '   ' });
    expect(r).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: post-draft with no real draft → null, no API call', async () => {
    const r = await buildSanityImpression({ ...POST, draftText: 'too short' });
    expect(r).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: truncation (max_tokens) → null', async () => {
    create.mockResolvedValueOnce(toolResp('clear', 'x', '', 'max_tokens'));
    expect(await buildSanityImpression(PRE)).toBeNull();
  });

  it('FAIL-OPEN: malformed impression level → null', async () => {
    create.mockResolvedValueOnce(toolResp('looks-fine', 'not a valid enum'));
    expect(await buildSanityImpression(PRE)).toBeNull();
  });

  it('FAIL-OPEN: API error → null (never throws)', async () => {
    create.mockRejectedValueOnce(new Error('529 overloaded'));
    expect(await buildSanityImpression(PRE)).toBeNull();
  });

  it('clamps a runaway summary to a glanceable length', async () => {
    create.mockResolvedValueOnce(toolResp('clear', 'word '.repeat(400)));
    const r = await buildSanityImpression(PRE);
    expect(r?.summary.length).toBeLessThanOrEqual(600);
  });
});
