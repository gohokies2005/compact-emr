import { describe, it, expect } from 'vitest';
import { stepFromManifest } from '../components/InFlightDrafterPanel';

// The drafter posts currentPhase only while a phase is actively 'running' and omits it at startup
// and between phases, so the scalar is frequently null — which froze the bar at "Step 1 of 6".
// The manifest (always stored) is the reliable source; stepFromManifest must derive the furthest
// step from it. (Ryan 2026-06-04: "1/6 ... always stuck there.")
describe('stepFromManifest', () => {
  it('returns the furthest step from running/ran phases even with no currentPhase', () => {
    const snapshot = {
      phases: {
        preflight: { id: 'preflight', status: 'ran' },
        framing_gate: { id: 'framing_gate', status: 'ran' },
        drafter: { id: 'drafter', status: 'running' },
      },
    };
    expect(stepFromManifest(snapshot)?.index).toBe(3); // drafter = step 3
  });

  it('never moves backward — uses the MAX step, not the last entry', () => {
    const snapshot = {
      phases: {
        grader: { id: 'grader', status: 'ran' }, // step 6
        render: { id: 'render', status: 'running' }, // step 6
        citation_scoring: { id: 'citation_scoring', status: 'ran' }, // step 5
      },
    };
    expect(stepFromManifest(snapshot)?.index).toBe(6);
  });

  it('counts skipped/done phases as progress past them', () => {
    const snapshot = {
      phases: {
        preflight: { id: 'preflight', status: 'ran' },
        cover_memo: { id: 'cover_memo', status: 'skipped' }, // step 2
      },
    };
    expect(stepFromManifest(snapshot)?.index).toBe(2);
  });

  it('ignores not-yet-started (pending) phases', () => {
    const snapshot = {
      phases: {
        preflight: { id: 'preflight', status: 'ran' }, // step 1
        drafter: { id: 'drafter', status: 'pending' }, // not started
      },
    };
    expect(stepFromManifest(snapshot)?.index).toBe(1);
  });

  it('also accepts an array-shaped phases manifest', () => {
    const snapshot = { phases: [{ id: 'drafter', status: 'running' }] };
    expect(stepFromManifest(snapshot)?.index).toBe(3);
  });

  it('returns null for an empty/absent/garbage manifest so the caller falls back to currentPhase', () => {
    expect(stepFromManifest(null)).toBeNull();
    expect(stepFromManifest({})).toBeNull();
    expect(stepFromManifest({ phases: {} })).toBeNull();
    expect(stepFromManifest({ phases: { x: { id: 'unknown_phase', status: 'running' } } })).toBeNull();
  });
});
