import { describe, it, expect } from 'vitest';
import { formatChartSlice, type ChartSliceData } from '../chartSlice.js';
import type { CaseFraming } from '../../services/case-framing.js';

const base: ChartSliceData = {
  claimType: 'secondary',
  claimedCondition: 'OSA',
  claimedConditions: ['OSA'],
  upstreamScCondition: 'PTSD',
  scConditions: [{ condition: 'PTSD', status: 'service_connected', ratingPct: 70, dcCode: '9411' }],
  activeProblems: [{ problem: 'Obesity', icd10: 'E66.9', notes: 'BMI 34' }],
  activeMedications: [{ drugName: 'sertraline', indication: 'PTSD' }],
  veteranStatement: null,
  inServiceEvent: null,
  caseFraming: null,
  documentDigest: null,
  emailThread: null,
  staffNotes: null,
  staffMessages: null,
};

describe('formatChartSlice', () => {
  it('builds a compact slice with claim, SC conditions, problems, meds', () => {
    const { text } = formatChartSlice(base);
    expect(text).toContain('Claim: OSA (secondary)');
    expect(text).toContain('Stated upstream SC condition: PTSD');
    expect(text).toContain('- PTSD (70%) [DC 9411] — service_connected');
    expect(text).toContain('- Obesity [E66.9]: BMI 34');
    expect(text).toContain('- sertraline (for PTSD)');
  });

  it('derives the retrieval condition list = claimed + upstream + SC anchors, deduped', () => {
    const { conditions } = formatChartSlice(base);
    expect(conditions).toContain('OSA');
    expect(conditions).toContain('PTSD');
    expect(conditions.filter((c) => c === 'PTSD')).toHaveLength(1); // upstream + SC anchor collapse to one
  });

  it('handles an empty chart with "(none recorded)"', () => {
    const { text, conditions } = formatChartSlice({ ...base, scConditions: [], activeProblems: [], activeMedications: [] });
    expect(text).toContain('Service-connected conditions of record:\n  (none recorded)');
    expect(text).toContain('Active problem list:\n  (none recorded)');
    expect(conditions).toContain('OSA');
  });

  it('omits the medications block when there are none', () => {
    expect(formatChartSlice({ ...base, activeMedications: [] }).text).not.toContain('Active medications:');
  });

  it('renders the veteran statement + in-service event sections when present, capped + collapsed', () => {
    const { text } = formatChartSlice({
      ...base,
      veteranStatement: 'I have trouble  sleeping\n\nsince my deployment.',
      inServiceEvent: 'Convoy IED blast in Iraq, 2007.',
    });
    expect(text).toContain("Veteran's statement (lay narrative):");
    expect(text).toContain('I have trouble sleeping since my deployment.'); // whitespace collapsed
    expect(text).toContain('Stated in-service event/exposure:');
    expect(text).toContain('Convoy IED blast in Iraq, 2007.');
  });

  it('caps an over-long veteran statement with an ellipsis', () => {
    const { text } = formatChartSlice({ ...base, veteranStatement: 'w'.repeat(2000) });
    const run = (text.match(/w+/g) ?? []).reduce((a, b) => Math.max(a, b.length), 0);
    expect(run).toBe(1200);
    expect(text).toContain('…');
  });

  it('omits narrative sections entirely when null/blank', () => {
    const { text } = formatChartSlice({ ...base, veteranStatement: '   ', inServiceEvent: null });
    expect(text).not.toContain("Veteran's statement");
    expect(text).not.toContain('Stated in-service event');
  });

  it('renders the system-derived case framing block', () => {
    const framing: CaseFraming = {
      version: 1,
      framing: 'secondary',
      grantedScAnchors: [{ condition: 'PTSD', ratingPct: 70, status: 'service_connected' }],
      upstreamScCondition: 'PTSD',
      framingChoice: 'secondary',
      claimType: 'initial',
      source: 'derived',
      derivedAt: '2026-06-11T00:00:00.000Z',
    };
    const { text } = formatChartSlice({ ...base, caseFraming: framing });
    expect(text).toContain('Case framing (system-derived):');
    expect(text).toContain('theory: secondary; claimType: initial; source: derived');
    expect(text).toContain('upstream SC condition: PTSD');
    expect(text).toContain('RN framing choice: secondary');
    expect(text).toContain('granted SC anchors: PTSD (70%)');
  });

  it('inlines the document digest block when present', () => {
    const digest = 'Documents on file: 2 (1 extracted)\n  - rating.pdf · — · extracted · 3pp';
    const { text } = formatChartSlice({ ...base, documentDigest: digest });
    expect(text).toContain('Documents on file: 2 (1 extracted)');
    expect(text).toContain('- rating.pdf · — · extracted · 3pp');
  });

  it('renders the email / staff-notes / staff-messages sections when present (Ask Aegis sees the whole chart)', () => {
    const { text } = formatChartSlice({
      ...base,
      emailThread: '  [2026-06-15] Our team: Records request\n    Please upload your sleep study.',
      staffNotes: '  [2026-06-14] Awaiting records from veteran.',
      staffMessages: '  [2026-06-15] physician: confirmed PTSD already SC',
    });
    expect(text).toContain('Email correspondence');
    expect(text).toContain('Please upload your sleep study.');
    expect(text).toContain('Staff notes (internal');
    expect(text).toContain('Awaiting records from veteran.');
    expect(text).toContain('Internal staff messages on this case:');
    expect(text).toContain('confirmed PTSD already SC');
  });

  it('omits the new sections entirely when null (no empty headers)', () => {
    const { text } = formatChartSlice(base); // all three null
    expect(text).not.toContain('Email correspondence');
    expect(text).not.toContain('Staff notes (internal');
    expect(text).not.toContain('Internal staff messages');
  });
});
