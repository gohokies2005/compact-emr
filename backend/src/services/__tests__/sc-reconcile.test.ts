import { describe, it, expect } from 'vitest';
import { reconcileScConditions } from '../sc-reconcile.js';

describe('reconcileScConditions — collapse same-condition rows to authoritative status', () => {
  // The exact Ryan 2026-06-20 complaint: PTSD shown service_connected AND pending.
  it('PTSD service_connected + posttraumatic stress disorder pending → ONE service_connected row', () => {
    const out = reconcileScConditions([
      { condition: 'PTSD', status: 'service_connected', ratingPct: 70 },
      { condition: 'Posttraumatic Stress Disorder', status: 'pending', ratingPct: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('service_connected');
    expect(out[0]!.ratingPct).toBe(70);
  });

  it('OSA + Obstructive Sleep Apnea (same status) → collapses to one', () => {
    const out = reconcileScConditions([
      { condition: 'OSA', status: 'service_connected', ratingPct: 50 },
      { condition: 'Obstructive Sleep Apnea', status: 'service_connected', ratingPct: 50 },
    ]);
    expect(out).toHaveLength(1);
  });

  it('denied NEVER wins over service_connected (grant supersedes stale denial)', () => {
    const out = reconcileScConditions([
      { condition: 'Hypertension', status: 'denied' },
      { condition: 'HTN', status: 'service_connected', ratingPct: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('service_connected');
  });

  it('within equal status, the rated row wins (more complete)', () => {
    const out = reconcileScConditions([
      { condition: 'Tinnitus', status: 'service_connected', ratingPct: null },
      { condition: 'Tinnitus', status: 'service_connected', ratingPct: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.ratingPct).toBe(10);
  });

  it('distinct conditions pass through, order preserved', () => {
    const out = reconcileScConditions([
      { condition: 'PTSD', status: 'service_connected' },
      { condition: 'Tinnitus', status: 'service_connected' },
      { condition: 'GERD', status: 'pending' },
    ]);
    expect(out.map((r) => r.condition)).toEqual(['PTSD', 'Tinnitus', 'GERD']);
  });

  it('preserves all non-status fields on the surviving row', () => {
    const out = reconcileScConditions([
      { condition: 'PTSD', status: 'pending', ratingPct: null, dcCode: '9411', id: 'a' },
      { condition: 'post-traumatic stress disorder', status: 'service_connected', ratingPct: 70, dcCode: '9411', id: 'b' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('b');
    expect(out[0]!.dcCode).toBe('9411');
  });

  it('empty / single-row inputs pass through unchanged', () => {
    expect(reconcileScConditions([])).toEqual([]);
    expect(reconcileScConditions([{ condition: 'PTSD', status: 'service_connected' }])).toHaveLength(1);
  });

  // PURITY: the input rows must NOT be mutated (read-time, DB rows untouched).
  it('is pure — does not mutate the input rows', () => {
    const input = [
      { condition: 'PTSD', status: 'service_connected', ratingPct: 70 },
      { condition: 'post-traumatic stress disorder', status: 'pending', ratingPct: null },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = reconcileScConditions(input);
    expect(input).toEqual(snapshot); // unmutated
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(input[0]); // a fresh merged object, not the original reference
  });

  it('rows with no condition string pass through (never dropped)', () => {
    const out = reconcileScConditions([{ condition: '', status: 'pending' }]);
    expect(out).toHaveLength(1);
  });

  // ── QA-hardening (architect + anthropic-ai-sme, 2026-06-20) ──

  // LATERALITY must NOT collapse — left/right are separate ratings; a false-merge would
  // HIDE a real claim. QUALIFIER_SUFFIXES does not strip laterality; lock that here.
  it('left vs right (laterality) stay SEPARATE — never false-merge', () => {
    const out = reconcileScConditions([
      { condition: 'Left knee strain', status: 'service_connected', ratingPct: 10 },
      { condition: 'Right knee strain', status: 'service_connected', ratingPct: 20 },
    ]);
    expect(out).toHaveLength(2);
  });

  // diabetes type 1 must never fold into type 2 (NAME_SYNONYMS deliberately omits it).
  it('diabetes type 1 vs type 2 stay separate', () => {
    const out = reconcileScConditions([
      { condition: 'Diabetes mellitus type 1', status: 'service_connected' },
      { condition: 'Diabetes mellitus type 2', status: 'service_connected' },
    ]);
    expect(out).toHaveLength(2);
  });

  // SC + denied = possible granted-then-SEVERED → flag statusConflict (do not silently resurrect).
  it('service_connected + denied → collapses but sets statusConflict', () => {
    const out = reconcileScConditions([
      { condition: 'Obstructive Sleep Apnea', status: 'denied' },
      { condition: 'OSA', status: 'service_connected', ratingPct: 50 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('service_connected');
    expect(out[0]!.statusConflict).toBe(true);
  });

  // SC + pending (the common Ryan case) must NOT be flagged as a conflict.
  it('service_connected + pending → NO statusConflict (common dup, not contradictory)', () => {
    const out = reconcileScConditions([
      { condition: 'PTSD', status: 'service_connected', ratingPct: 70 },
      { condition: 'post-traumatic stress disorder', status: 'pending' },
    ]);
    expect(out[0]!.statusConflict).toBeUndefined();
  });

  // never silently drop a needs-review flag when the reviewed row loses.
  it('preserves needsReview if ANY group member needed review', () => {
    const out = reconcileScConditions([
      { condition: 'GERD', status: 'service_connected', ratingPct: 10, needsReview: false },
      { condition: 'Gastroesophageal reflux disease', status: 'pending', needsReview: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.needsReview).toBe(true);
  });

  // winner inherits a dcCode it lacked from a same-condition group member.
  it('inherits dcCode onto the winner when it lacked one', () => {
    const out = reconcileScConditions([
      { condition: 'Tinnitus', status: 'service_connected', ratingPct: 10, dcCode: null },
      { condition: 'Tinnitus', status: 'pending', dcCode: '6260' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.dcCode).toBe('6260');
  });
});
