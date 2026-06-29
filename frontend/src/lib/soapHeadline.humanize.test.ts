// TITLE HUMANIZER (Dr. Kasky 2026-06-28): a raw enum token (lowercase axis word / snake_case event key) must
// never reach the user as the bold headline. humanizeFraming rewrites ONLY a bare enum token into spaced
// Title Case; real framing prose is returned untouched. Pinned so the "direct"/"in_service_onset" leak can't
// come back and so a human-written headline is never mangled.
import { describe, it, expect } from 'vitest';
import { humanizeFraming, soapHeadline } from './soapHeadline';

describe('humanizeFraming', () => {
  it('rewrites a bare lowercase axis token: "direct" → "Direct"', () => {
    expect(humanizeFraming('direct')).toBe('Direct');
    expect(humanizeFraming('secondary')).toBe('Secondary');
  });

  it('rewrites a snake_case event key: "in_service_onset" → "In Service Onset"', () => {
    expect(humanizeFraming('in_service_onset')).toBe('In Service Onset');
    expect(humanizeFraming('in_service_onset_lay_evidence')).toBe('In Service Onset Lay Evidence');
  });

  it('leaves real framing PROSE untouched (never mangles a human headline)', () => {
    const prose = 'OSA secondary to service-connected allergic rhinitis (causation)';
    expect(humanizeFraming(prose)).toBe(prose);
    // A capitalized acronym / deterministic title is prose, not a bare enum → untouched.
    expect(humanizeFraming('Ready to draft')).toBe('Ready to draft');
    expect(humanizeFraming('Draft')).toBe('Draft');
  });

  it('collapses whitespace on prose but does not enum-ify it', () => {
    expect(humanizeFraming('  spaced   out  ')).toBe('spaced out');
  });

  it('null / empty → empty string', () => {
    expect(humanizeFraming(null)).toBe('');
    expect(humanizeFraming(undefined)).toBe('');
    expect(humanizeFraming('   ')).toBe('');
  });
});

describe('soapHeadline applies the humanizer end-to-end', () => {
  it('a GROUNDED note whose route-picker framing leaked a raw enum renders as Title Case, not the raw token', () => {
    const h = soapHeadline({
      grounded: true, stale: false, routePickerFraming: 'in_service_onset',
      strategyPrimaryArgument: null, anchorHeadline: null, resultTitle: 'Draft',
    });
    expect(h).toBe('In Service Onset');
  });

  it('a normal prose framing still passes through unchanged (regression)', () => {
    const FRAMING = 'OSA secondary to service-connected allergic rhinitis (causation)';
    const h = soapHeadline({
      grounded: true, stale: false, routePickerFraming: FRAMING,
      strategyPrimaryArgument: 'strategy', anchorHeadline: null, resultTitle: 'Draft',
    });
    expect(h).toBe(FRAMING);
  });
});
