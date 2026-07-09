import { describe, expect, it } from 'vitest';
import { buildAnchorGuidance } from '../ai-viability.js';

// Provenance split for the team steer (Ryan 2026-07-09, CLM-E09DA2C73F orphan-steer trap):
// a PHYSICIAN/RN-selected anchor (framingStampSource==='manual') is a trusted steer; an auto-DERIVED
// or orphan anchor (framingStampSource 'derived' | null) is only a tiebreak HINT and must self-label
// as such so the picker prompt does not treat it as physician-chosen. The framing PREFERENCE (type)
// is unaffected by provenance.
describe('buildAnchorGuidance — provenance-aware team steer', () => {
  it('renders a MANUAL (physician/RN-selected) anchor as a trusted steer', () => {
    const g = buildAnchorGuidance('secondary', 'Diabetes type 2', 'manual');
    expect(g).toContain('physician/RN-selected upstream anchor: Diabetes type 2');
    expect(g).not.toContain('HINT');
  });

  it('renders an ORPHAN (null stamp source) anchor as a tiebreak HINT, not a trusted steer', () => {
    const g = buildAnchorGuidance('secondary', 'Diabetes type 2', null);
    expect(g).toContain('Diabetes type 2');
    expect(g).toContain('HINT');
    expect(g).not.toContain('physician/RN-selected');
  });

  it('renders a DERIVED anchor as a tiebreak HINT (same as orphan)', () => {
    const g = buildAnchorGuidance('secondary', 'Diabetes type 2', 'derived');
    expect(g).toContain('HINT');
    expect(g).not.toContain('physician/RN-selected');
  });

  it('always includes the framing preference verbatim (framing type is provenance-independent)', () => {
    expect(buildAnchorGuidance('aggravation', null, 'manual')).toBe('framing preference: aggravation');
    expect(buildAnchorGuidance('secondary', 'PTSD', 'manual')).toContain('framing preference: secondary');
  });

  it('returns null when there is no framing preference and no anchor', () => {
    expect(buildAnchorGuidance(null, null, null)).toBeNull();
  });
});
