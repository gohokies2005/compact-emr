import { describe, it, expect } from 'vitest';
import { buildDraftHaltSummary, type ManifestLike, type ManifestPhaseLike } from '../lib/draftHaltSummary';

const ran = (id: string) => ({ id, status: 'ran' });
const crashed = (id: string, msg?: string) => ({ id, status: 'crashed', ...(msg ? { operator_message: msg } : {}) });

// All phases ran except the named crash; everything after the crash is absent (never reached).
function manifest(crashId: string | null, extra: Record<string, string> = {}): ManifestLike {
  const order = ['preflight', 'index_consult', 'framing_gate', 'cover_memo', 'source_lock', 'drafter', 'adversary_panel', 'specialist_gate', 'refine_loop', 'surgical_edit', 'citation_scoring', 'pmid_verify', 'linter', 'qa_report', 'grader', 'render', 'render_parity'];
  const phases: Record<string, ManifestPhaseLike> = {};
  for (const id of order) {
    if (id === crashId) { phases[id] = crashed(id, extra[id]); break; }
    phases[id] = ran(id);
  }
  return { phases };
}

describe('buildDraftHaltSummary', () => {
  it('COSMETIC halt (render_parity crashed, B+ ship) → ship-as-is, no fix-first, checklist stops at Final formatting check', () => {
    const s = buildDraftHaltSummary(manifest('render_parity'), { grade: 'B+', ship_recommendation: 'ship', grade_rationale_plain: 'Strong letter.' });
    expect(s.grade).toBe('B+');
    expect(s.ship).toBe('ship');
    expect(s.cosmetic).toBe(true);
    expect(s.stoppedAtLabel).toBe('Final formatting check');
    expect(s.nextAction).toMatch(/confirm it reads correctly.*sign and send/i);
    // the formatting step is the only ✗; earlier stages done
    const stopped = s.steps.find((x) => x.status === 'stopped');
    expect(stopped?.label).toBe('Final formatting check');
    expect(s.steps.find((x) => x.label === 'Wrote the draft')?.status).toBe('done');
    expect(s.steps.find((x) => x.label === 'Graded the letter')?.status).toBe('done');
  });

  it('SUBSTANTIVE halt (citation could not be verified, revise + hints) → NOT cosmetic, leads with fix-first + names the fix', () => {
    const s = buildDraftHaltSummary(manifest('pmid_verify'), {
      grade: 'B', ship_recommendation: 'revise',
      targeted_revision_hints: [{ issue: 'A citation could not be verified', section: 'Section VI', suggested_fix: 'confirm it is real or remove it' }],
    });
    expect(s.cosmetic).toBe(false);
    expect(s.stoppedAtLabel).toBe('Quality checks');
    expect(s.fixList.length).toBe(1);
    expect(s.fixList[0]).toMatch(/could not be verified.*Section VI.*remove it/i);
    expect(s.nextAction).toMatch(/do NOT send/i);
  });

  it('CLEAN finish (no crash) → no stopped step, ship guidance, not cosmetic', () => {
    const s = buildDraftHaltSummary(manifest(null), { grade: 'A-', ship_recommendation: 'ship' });
    expect(s.stoppedAtLabel).toBeNull();
    expect(s.cosmetic).toBe(false);
    expect(s.nextAction).toMatch(/sign\/send|final read/i);
    expect(s.steps.every((x) => x.status === 'done')).toBe(true);
  });

  it('a code-ish phase message is NEVER surfaced — falls back to a plain reason', () => {
    const s = buildDraftHaltSummary(manifest('render_parity', { render_parity: 'render_parity_mismatch: threw at offset 11037 {request_id:...}' }), { grade: 'B+', ship_recommendation: 'ship' });
    const stopped = s.steps.find((x) => x.status === 'stopped');
    expect(stopped?.reason).toMatch(/formatting difference/i);
    expect(stopped?.reason).not.toMatch(/threw|request_id|offset|\{/);
  });

  it('synthesized floor grade is flagged (the run died before the real grader)', () => {
    const s = buildDraftHaltSummary(manifest('drafter'), { grade: 'C', ship_recommendation: 'revise', synthesized_floor: true });
    expect(s.gradeIsFloor).toBe(true);
    expect(s.stoppedAtLabel).toBe('Wrote the draft');
  });

  // SAFETY: the all-good face is the leak the QA panel caught. A substantive/floor halt must NEVER be shipAsIs,
  // even when an earlier grader stamped ship_recommendation:'ship' before a later crash.
  it('SAFETY: a synthesized floor grade with ship=ship is NOT shipAsIs', () => {
    const s = buildDraftHaltSummary(manifest('grader'), { grade: 'C', ship_recommendation: 'ship', synthesized_floor: true });
    expect(s.gradeIsFloor).toBe(true);
    expect(s.shipAsIs).toBe(false);
  });

  it('SAFETY: a substantive crash (pmid_verify) with ship=ship and NO fixList is NOT shipAsIs', () => {
    const s = buildDraftHaltSummary(manifest('pmid_verify'), { grade: 'B', ship_recommendation: 'ship' });
    expect(s.cosmetic).toBe(false);
    expect(s.stoppedAtLabel).toBe('Quality checks');
    expect(s.shipAsIs).toBe(false);
  });

  it('SAFETY: a cosmetic render_parity crash with ship=ship IS shipAsIs (the one allowed ship-as-is)', () => {
    const s = buildDraftHaltSummary(manifest('render_parity'), { grade: 'B+', ship_recommendation: 'ship' });
    expect(s.cosmetic).toBe(true);
    expect(s.shipAsIs).toBe(true);
  });

  it('a clean finish with a real ship grade and no fixes IS shipAsIs', () => {
    const s = buildDraftHaltSummary(manifest(null), { grade: 'A-', ship_recommendation: 'ship' });
    expect(s.shipAsIs).toBe(true);
  });
});
