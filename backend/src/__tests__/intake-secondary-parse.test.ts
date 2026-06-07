import { describe, it, expect } from 'vitest';
import { parseSecondaryFraming } from '../services/intake-derive.js';

// Grounded in REAL live Jotform statements (2026-06-07). Veterans state the secondary link themselves;
// the case must NOT default to "direct" when they wrote "secondary to X".
describe('parseSecondaryFraming — the secondary anchor the veteran stated', () => {
  const cases: Array<[string, string]> = [
    ['I believe my sleep apnea is secondary to my service-connected PTSD and GERD.', 'ptsd'],
    ['Secondary to my ptsd', 'ptsd'],
    ['Trying to get secondary to PTSD', 'ptsd'],
    ['I believe my GERD is caused or aggravated by my service-connected lumbar spine condition', 'lumbar'],
    ['Second time getting denied secondary to major depression and anxiety', 'depression'],
    ['Migraines secondary to service-connected tinnitus.', 'tinnitus'],
    ['Claiming sleep apnea as secondary to service-connected PTSD', 'ptsd'],
  ];
  for (const [text, expected] of cases) {
    it(`captures "${expected}" from: ${text.slice(0, 38)}…`, () => {
      const r = parseSecondaryFraming(text);
      expect(r, text).toBeDefined();
      expect(r?.upstream.toLowerCase()).toContain(expected);
    });
  }

  it('returns undefined for a direct-only statement', () => {
    expect(parseSecondaryFraming('Symptoms developed during service, documented; positive diagnosis years later.')).toBeUndefined();
  });

  it('rejects a garbage anchor — stays direct, never "secondary to service I wake up with headaches"', () => {
    expect(parseSecondaryFraming('I have sleep apnea connected to service I wake up with headaches and migraines')).toBeUndefined();
  });

  it('flags aggravation framing when the veteran uses that word', () => {
    expect(parseSecondaryFraming('my OSA is aggravated by my service-connected PTSD')?.framing).toBe('aggravation');
  });
});
