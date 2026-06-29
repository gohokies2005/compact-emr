// Chip-stability hardening (Dr. Kasky 2026-06-28, "the Case-Overview/SOAP chip keeps changing color on its
// own, amber→green→amber"). Three guards in one suite:
//   1. DETERMINISM grep-pin: BOTH decision LLM calls (the route-picker band + the SOAP note) carry
//      temperature:0 — non-zero sampling let the chip-bearing band/action re-roll on an unchanged case.
//   2. STICKY VERDICT: reconcileStickyAction keeps the persisted chip-bearing action through an UNGROUNDED
//      recompute (no new band) and only lets it change on a GROUNDED (authoritative-band) recompute.
//   3. AMBER = WORK-ORDER reframe: the SOAP prompt/Plan prose no longer tells the RN to "route to a physician
//      to decide" — physicians review + sign; the RN + engine make the go/no-go.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileStickyAction, type SoapNote } from '../soap-overview.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(path.join(here, '..', rel), 'utf8');

describe('determinism: both decision LLM calls pin temperature:0', () => {
  it('the route-picker (ai-viability.ts) messages.create carries temperature:0, not 0.5', () => {
    const src = readSrc('ai-viability.ts');
    // The active code line — temperature: 0, (the band decided here drives the chip + the SOAP action).
    expect(src).toMatch(/temperature:\s*0\s*,/);
    // No ACTIVE temperature:0.5 (the old value). A bare "0.5" in prose comments is allowed; the code form
    // "temperature: 0.5" must be gone.
    expect(src).not.toMatch(/temperature:\s*0\.5/);
  });

  it('the SOAP note (soap-overview.ts) messages.create carries an explicit temperature:0 (no SDK-default 1.0)', () => {
    const src = readSrc('soap-overview.ts');
    expect(src).toMatch(/temperature:\s*0\s*,/);
    expect(src).not.toMatch(/temperature:\s*0\.5/);
  });
});

// ── STICKY VERDICT ────────────────────────────────────────────────────────────────────────────────────
const NOTE = (over: Partial<SoapNote> = {}): SoapNote => ({
  subjective: 's', objective: 'o', assessment: 'a', plan: 'p',
  confidence: 'moderate', action: 'draft', caveat: null, fallback: false, ...over,
});

describe('reconcileStickyAction — the chip does not wobble on an ungrounded recompute', () => {
  it('no stored note → take the fresh note as-is (first generation)', () => {
    const fresh = NOTE({ action: 'physician_review' });
    expect(reconcileStickyAction(fresh, null, false)).toBe(fresh);
  });

  it('UNGROUNDED recompute whose action DIFFERS from the stored one → REVERT to the stored action (no wobble)', () => {
    const stored = NOTE({ action: 'draft', confidence: 'high' });
    const fresh = NOTE({ action: 'physician_review', confidence: 'low', assessment: 'fresh prose' });
    const out = reconcileStickyAction(fresh, stored, false);
    expect(out.action).toBe('draft');         // chip stays the prior decision
    expect(out.confidence).toBe('high');       // and the confidence travels with the preserved decision
    expect(out.assessment).toBe('fresh prose'); // prose still refreshes
  });

  it('GROUNDED recompute (authoritative band) whose action differs → PROPAGATE the new action (a real decision change)', () => {
    const stored = NOTE({ action: 'draft' });
    const fresh = NOTE({ action: 'reject' }); // the route-picker band genuinely flipped to not_supportable
    expect(reconcileStickyAction(fresh, stored, true).action).toBe('reject');
  });

  it('a TRANSIENT fallback fresh note is never reconciled (it is not persisted anyway)', () => {
    const stored = NOTE({ action: 'draft' });
    const fresh = NOTE({ action: 'physician_review', fallback: true });
    expect(reconcileStickyAction(fresh, stored, false)).toBe(fresh);
  });

  it('a stored TRANSIENT fallback is not stuck to (we never anchor on a transient brief)', () => {
    const stored = NOTE({ action: 'physician_review', fallback: true });
    const fresh = NOTE({ action: 'draft' });
    expect(reconcileStickyAction(fresh, stored, false).action).toBe('draft');
  });

  it('ungrounded recompute whose action AGREES with stored → unchanged (nothing to stick)', () => {
    const stored = NOTE({ action: 'get_records' });
    const fresh = NOTE({ action: 'get_records', objective: 'new obj' });
    const out = reconcileStickyAction(fresh, stored, false);
    expect(out.action).toBe('get_records');
    expect(out.objective).toBe('new obj');
  });
});

// ── AMBER = A WORK ORDER, NOT A REFERRAL (RN-empowering reframe) ─────────────────────────────────────────
describe('amber reframe: the SOAP prompt no longer routes the go/no-go to a physician', () => {
  const src = readSrc('soap-overview.ts');
  it('the dropped "Route to a physician to confirm the theory" Plan line is gone', () => {
    expect(src).not.toContain('Route to a physician to confirm the theory');
  });
  it('the Plan is framed as an RN WORK ORDER that prefers an Ask-Aegis / chart check', () => {
    expect(src).toContain('RN WORK ORDER');
    expect(src).toContain('Ask-Aegis');
  });
  it('the SYSTEM prompt states physicians REVIEW and SIGN (RN + engine make the go/no-go)', () => {
    expect(src).toContain('REVIEWS and SIGNS');
    expect(src).toMatch(/ask the doctor what he thinks/i); // the explicit forbidden phrasing is named
  });
  // ASK-AEGIS IS A CONSIDERATION, NOT THE DEFAULT (Dr. Kasky 2026-06-29): the prompt + plan prose must offer
  // Ask-Aegis as an OPTIONAL second read, never as the imperative "run a named/an Ask-Aegis check" the RN is
  // obligated to do. The "Ask-Aegis" token stays (it is still one tool among several); only the imperative goes.
  it('Ask-Aegis is framed as an OPTIONAL consideration, not a mandatory "run an Ask-Aegis check" step', () => {
    expect(src).toContain('Ask-Aegis');                      // still offered as one option
    expect(src).toMatch(/OPTIONAL consideration/);           // explicitly optional in the prompt + tool desc
    expect(src).not.toMatch(/run a named Ask-Aegis check/i); // the old imperative wording is gone
    expect(src).not.toMatch(/run an Ask-Aegis check on the mechanism/i);
  });
});
