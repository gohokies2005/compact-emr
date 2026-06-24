import { describe, it, expect } from 'vitest';
import { evaluateDraftReadiness, getDraftReadiness, type DraftReadinessInput } from '../draft-readiness.js';
import { computeTriggerHash } from '../chart-build-state.js';
import type { AppDb } from '../db-types.js';

function base(over: Partial<DraftReadinessInput> = {}): DraftReadinessInput {
  return {
    claimType: 'initial',
    framingChoice: 'secondary', // most FRN claims are secondary; SC primary is then required
    claimedCondition: 'Obstructive sleep apnea',
    claimedConditions: [],
    inServiceEvent: 'Documented sleep complaints during service',
    grantedScCount: 1,
    noScConditionsConfirmed: false,
    problemNames: ['Obstructive sleep apnea', 'Tinnitus'],
    documents: [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }],
    ...over,
  };
}

describe('evaluateDraftReadiness', () => {
  it('is ready when all essentials are present (initial claim, no denial required)', () => {
    const r = evaluateDraftReadiness(base());
    expect(r.ready).toBe(true);
    expect(r.missing).toHaveLength(0);
    // No denial item on an initial claim.
    expect(r.items.find((i) => i.key === 'denial_letter')).toBeUndefined();
  });

  it('blocks with the rating-decision message when no granted SC condition is on file (Armand)', () => {
    const r = evaluateDraftReadiness(base({ grantedScCount: 0 }));
    expect(r.ready).toBe(false);
    const sc = r.missing.find((m) => m.key === 'sc_conditions')!;
    expect(sc.message).toContain('Please upload the VA rating decision');
    expect(sc.message).toContain('redraft');
  });

  it('requires a denial letter on an appeal and flags it missing in Ryan\'s wording', () => {
    const r = evaluateDraftReadiness(base({ claimType: 'supplemental', documents: [{ filename: 'DD-214.pdf', docTag: null }] }));
    const denial = r.missing.find((m) => m.key === 'denial_letter')!;
    expect(denial.message).toBe('Essential documents missing: This is an appeal. Please upload the VA denial letter being appealed and redraft.');
  });

  it('detects a denial letter by filename on an appeal', () => {
    const r = evaluateDraftReadiness(base({ claimType: 'supplemental', documents: [
      { filename: 'Armand Frank Sleep Apnea Denial 2026.pdf', docTag: 'Other' },
      { filename: 'DD-214.pdf', docTag: null },
    ] }));
    expect(r.items.find((i) => i.key === 'denial_letter')!.present).toBe(true);
  });

  it('treats the claimed condition as diagnosed via synonym folding (OSA == Obstructive sleep apnea)', () => {
    const r = evaluateDraftReadiness(base({ claimedCondition: 'OSA', problemNames: ['Obstructive Sleep Apnea'] }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('flags a missing current diagnosis when the claimed condition is not in the problem list', () => {
    const r = evaluateDraftReadiness(base({ claimedCondition: 'GERD', problemNames: ['Tinnitus'] }));
    const dx = r.missing.find((m) => m.key === 'current_diagnosis')!;
    expect(dx.message).toContain('A current diagnosis for GERD is not on file');
  });

  it('accepts a DD-214 as the in-service-event proxy when the event text is blank', () => {
    const r = evaluateDraftReadiness(base({ inServiceEvent: null, documents: [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }] }));
    expect(r.items.find((i) => i.key === 'in_service_event')!.present).toBe(true);
  });

  it('flags a missing in-service event when there is no event text and no service record', () => {
    const r = evaluateDraftReadiness(base({ inServiceEvent: '', documents: [{ filename: 'Benefit Summary.pdf', docTag: null }] }));
    const ev = r.missing.find((m) => m.key === 'in_service_event')!;
    expect(ev.message).toContain('Please upload the DD-214 or service treatment record');
  });

  it('produces a plain one-line summary listing what is missing', () => {
    const r = evaluateDraftReadiness(base({ grantedScCount: 0 }));
    expect(r.summary).toBe('Essential documents missing: Service-connected primary. Please upload and redraft.');
  });

  // ---- framing-aware SC rule ----
  it('does NOT require an SC primary for a DIRECT claim (zero SC is fine, no false block)', () => {
    const r = evaluateDraftReadiness(base({ framingChoice: 'direct', grantedScCount: 0 }));
    expect(r.items.find((i) => i.key === 'sc_conditions')).toBeUndefined();
    expect(r.ready).toBe(true);
  });

  it('also skips the SC requirement when framing is null (treated as not-secondary)', () => {
    const r = evaluateDraftReadiness(base({ framingChoice: null, grantedScCount: 0 }));
    expect(r.items.find((i) => i.key === 'sc_conditions')).toBeUndefined();
  });

  it('secondary + confirmed-none → not viable as secondary (distinct message, not "upload")', () => {
    const r = evaluateDraftReadiness(base({ framingChoice: 'secondary', grantedScCount: 0, noScConditionsConfirmed: true }));
    const sc = r.missing.find((m) => m.key === 'sc_conditions')!;
    expect(sc.message).toContain('no service-connected condition to connect it to');
    expect(sc.message).toContain('refile this as a direct claim');
    expect(sc.message).not.toContain('upload the VA rating decision');
  });

  it('secondary + grants on file → SC primary present', () => {
    const r = evaluateDraftReadiness(base({ framingChoice: 'secondary', grantedScCount: 2 }));
    expect(r.items.find((i) => i.key === 'sc_conditions')!.present).toBe(true);
  });
});

// ── SAME-BRAIN Gate-1 (2026-06-21): the readiness reads the route-picker plan (the brain) + the granted-SC
// list + a lay statement + the extracted digest — not just the problem list + filename regexes. These pin the
// fix for false "missing dx/event" on a fully-extracted chart, and that GENUINE absences still flag.
describe('evaluateDraftReadiness — same-brain (route-picker plan + chart facts)', () => {
  const plan = (missing: Array<{ fact: string; why: string }>) => ({
    framing: 'OSA secondary to service-connected chronic rhinitis (38 CFR 3.310(a))',
    cfr_basis: '38 CFR 3.310(a)', mechanism: 'nasal obstruction worsens upper-airway collapse',
    rationale: 'A defensible secondary causation theory anchored on the granted rhinitis.',
    viability: 'supportable' as const, missing,
  });

  it('FALSE-MISSING FIX: the brain read the full chart and did NOT flag dx/event missing → both present even with an empty problem list', () => {
    const r = evaluateDraftReadiness(base({
      problemNames: [], inServiceEvent: '', documents: [{ filename: 'records.pdf', docTag: null }],
      routePlan: plan([]), // brain found no gaps
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
    expect(r.items.find((i) => i.key === 'in_service_event')!.present).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.routePlan).toBeDefined();
    expect(r.routePlan!.framing).toContain('secondary');
  });

  it('GENUINE ABSENCE still flags: the brain explicitly lists the diagnosis as missing', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'GERD', problemNames: ['Tinnitus'],
      routePlan: plan([{ fact: 'A current diagnosis of GERD', why: 'no medical record shows a GERD diagnosis' }]),
    }));
    const dx = r.missing.find((m) => m.key === 'current_diagnosis');
    expect(dx).toBeDefined();
    expect(dx!.message).toContain('A current diagnosis for GERD is not on file');
  });

  it('a lay/buddy statement (§1154(b)) satisfies the in-service-event check with no event text and no service doc', () => {
    const r = evaluateDraftReadiness(base({
      inServiceEvent: '', layStatement: 'My battle buddy witnessed the IED blast that caused the injury.',
      documents: [{ filename: 'Benefit Summary.pdf', docTag: null }],
    }));
    const ev = r.items.find((i) => i.key === 'in_service_event')!;
    expect(ev.present).toBe(true);
    expect(ev.basis).toContain('1154(b)');
  });

  it('a granted SC condition counts as a documented diagnosis for the dx check', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Allergic rhinitis', problemNames: [], scConditionNames: ['Allergic rhinitis'],
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('canonicalizer match: claim "OSA" is documented by an on-file "Obstructive sleep apnea" via the vendored canonicalizer', () => {
    // normalizeName already folds this synonym; this also exercises the canonical path on a problem-list entry.
    const r = evaluateDraftReadiness(base({ claimedCondition: 'OSA', problemNames: ['Obstructive sleep apnea'], scConditionNames: [] }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('NO plan → byte-identical legacy behavior (a missing dx still flags)', () => {
    const r = evaluateDraftReadiness(base({ claimedCondition: 'GERD', problemNames: ['Tinnitus'], routePlan: null }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(false);
    expect(r.routePlan).toBeUndefined();
  });

  it('a denial in the extracted digest satisfies the appeal denial check even when no filename says "denial"', () => {
    const r = evaluateDraftReadiness(base({
      claimType: 'supplemental',
      documents: [{ filename: 'va_packet.pdf', docTag: null }, { filename: 'DD-214.pdf', docTag: null }],
      chartDigest: 'Rating decision dated 2020-06-01: the claim for sleep apnea is denied because...',
    }));
    expect(r.items.find((i) => i.key === 'denial_letter')!.present).toBe(true);
  });

  // ── #2 (downgrade-only trust) + #3 (single-bucket classification), adversarial-QA 2026-06-21.
  // The brain's missing[] may DOWNGRADE an essential (mark it missing) but may NEVER upgrade an essential to
  // present off a fact it could not classify, and one fact must land in exactly ONE bucket.

  it('#2 FALSE-PASS GUARD: an UNRECOGNIZED missing-dx fact + NO on-file dx → STILL FLAGS (no false-pass)', () => {
    // "no MRI on file" / "onset during active duty" wordings the cues do NOT recognize must not silence the
    // deterministic check. With no on-file dx, the dx essential must still flag missing.
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'GERD', problemNames: ['Tinnitus'], inServiceEvent: '',
      documents: [{ filename: 'records.pdf', docTag: null }],
      routePlan: {
        framing: 'GERD direct (38 CFR 3.303)', cfr_basis: '38 CFR 3.303', mechanism: 'x', rationale: 'y',
        viability: 'marginal',
        missing: [{ fact: 'no MRI on file', why: 'imaging would strengthen the claim' }],
      },
    }));
    const dx = r.items.find((i) => i.key === 'current_diagnosis')!;
    expect(dx.present).toBe(false); // the unrecognized fact must NOT mark the dx present
    // the in-service event has no deterministic evidence either, and the brain's silence is NOT trustworthy
    // here (an unclassified gap exists) → it must NOT be upgraded to present.
    expect(r.items.find((i) => i.key === 'in_service_event')!.present).toBe(false);
    // and the unrecognized gap is surfaced for the RN (over-flag, never false-pass).
    expect(r.unclassifiedGaps).toBeDefined();
    expect(r.unclassifiedGaps!.some((g) => g.fact === 'no MRI on file')).toBe(true);
  });

  it('#2 a clean plan (zero missing) still upgrades essentials to present (the legitimate same-brain win holds)', () => {
    const r = evaluateDraftReadiness(base({
      problemNames: [], inServiceEvent: '', documents: [{ filename: 'records.pdf', docTag: null }],
      routePlan: {
        framing: 'OSA secondary (38 CFR 3.310)', cfr_basis: '38 CFR 3.310(a)', mechanism: 'x', rationale: 'y',
        viability: 'supportable', missing: [],
      },
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
    expect(r.items.find((i) => i.key === 'in_service_event')!.present).toBe(true);
    expect(r.unclassifiedGaps).toBeUndefined();
  });

  // ── #1 (Hackworth, 2026-06-21): the dx check must NOT bail on a canon-unknown claim surface. The vendored
  // canon returns null for "Lumbar Back/Sciatica"/"lumbago"/"sciatica"; the old code returned false before the
  // on-file/digest scan, false-flagging a documented lumbar dx.
  it('#1 HACKWORTH: "Lumbar Back/Sciatica" is documented by an on-file "Lumbago" via the local synonym pre-fold', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Lumbar Back/Sciatica', problemNames: ['Lumbago'], scConditionNames: [],
      // no plan — pure deterministic path, isolating the canon/bail fix.
      routePlan: null,
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('#1 HACKWORTH: "Lumbar Back/Sciatica" is documented by an on-file "Sciatica"', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Lumbar Back/Sciatica', problemNames: ['Sciatica'], routePlan: null,
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('#1 HACKWORTH: "Lumbar Back/Sciatica" is documented by a digest assessment line mentioning lumbago', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Lumbar Back/Sciatica', problemNames: ['Tinnitus'], routePlan: null,
      chartDigest: 'Assessment: chronic lumbago with radicular symptoms, ongoing PT.',
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(true);
  });

  it('#1 GUARD: a canon-unknown claim with NOTHING matching on file STILL flags missing (no over-fold)', () => {
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Lumbar Back/Sciatica', problemNames: ['Tinnitus'], scConditionNames: ['Hypertension'],
      chartDigest: 'Sleep study: AHI 32. PFT normal.', routePlan: null,
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(false);
  });

  it('#1 GUARD: GERD (canon-known) not on file still flags missing — the raw fall-through does NOT fire for it', () => {
    const r = evaluateDraftReadiness(base({ claimedCondition: 'GERD', problemNames: ['Tinnitus'], routePlan: null }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(false);
  });

  it('#3 CROSS-BUCKET: "current diagnosis of the back injury" classifies to dx ONLY, not also event', () => {
    // This single fact trips both the dx (diagnos) and event (injur) cues. It must downgrade dx ONLY; with a
    // DD-214 on file the event essential stays satisfied deterministically — it must NOT be marked missing by
    // contamination, and (critically) the dx essential MUST flag because the brain flagged it.
    const r = evaluateDraftReadiness(base({
      claimedCondition: 'Lumbar strain', problemNames: ['Tinnitus'], inServiceEvent: '',
      documents: [{ filename: 'Hackworth DD-214.pdf', docTag: null }],
      routePlan: {
        framing: 'Lumbar direct (38 CFR 3.303)', cfr_basis: '38 CFR 3.303', mechanism: 'x', rationale: 'y',
        viability: 'marginal',
        missing: [{ fact: 'a current diagnosis of the back injury', why: 'no medical record shows it' }],
      },
    }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')!.present).toBe(false); // dx flagged (correct bucket)
    expect(r.items.find((i) => i.key === 'in_service_event')!.present).toBe(true);   // DD-214 carries it; NOT contaminated
    expect(r.unclassifiedGaps).toBeUndefined(); // the fact WAS classified (to dx) — not unclassified
  });
});

describe('getDraftReadiness (db gather)', () => {
  function mockDb(opts: {
    caseRow: unknown;
    granted?: unknown[];
    problems?: { problem: string }[];
    docs?: { filename: string; docTag: string | null }[];
    noScConfirmed?: boolean;
    runStatus?: string; // default 'complete' so build state is chart_ready
  }): AppDb {
    // Give each doc an id + s3Key, mark all OCR-terminal, and (by default) a COMPLETE run whose
    // triggerHash matches — so deriveChartBuildState returns chart_ready and the real readiness
    // evaluation runs. (The case-not-found test passes docs through harmlessly.)
    const rawDocs = opts.docs ?? [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }];
    const docs = rawDocs.map((d, i) => ({ id: `d${i}`, s3Key: `k${i}`, filename: d.filename, docTag: d.docTag }));
    const readStatuses = docs.map((d) => ({ filePath: d.s3Key, terminalStatus: 'read' }));
    const run = { triggerHash: computeTriggerHash(docs, readStatuses), status: opts.runStatus ?? 'complete' };
    // case.findFirst serves BOTH getDraftReadiness's own row read AND deriveCaseFramingForCase's
    // select (which pulls the veteran.scConditions relation). The relation must agree with the
    // scCondition.findMany result — a real Prisma db can never disagree with itself, so the mock
    // must not either (the SSOT consumption rewire reads the anchor list from the relation).
    const caseRowWithRelation = opts.caseRow == null ? null : {
      id: 'CLM-1',
      upstreamScCondition: null,
      veteranStatement: null,
      veteran: {
        scConditions: (opts.granted ?? []).map((_, i) => ({ condition: `Granted condition ${i + 1}`, ratingPct: 10, status: 'service_connected' })),
      },
      ...(opts.caseRow as Record<string, unknown>),
    };
    return {
      case: { findFirst: async () => caseRowWithRelation },
      veteran: { findFirst: async () => ({ noScConditionsConfirmed: opts.noScConfirmed ?? false }) },
      scCondition: { findMany: async () => opts.granted ?? [] },
      activeProblem: { findMany: async () => opts.problems ?? [] },
      document: { findMany: async () => docs },
      fileReadStatus: { findMany: async () => readStatuses },
      chartExtractionRun: { findFirst: async () => run },
    } as unknown as AppDb;
  }

  it('returns null when the case does not exist', async () => {
    const r = await getDraftReadiness(mockDb({ caseRow: null }), 'nope');
    expect(r).toBeNull();
  });

  it('gathers granted SC count + problems + docs and evaluates ready (Armand-shaped, complete)', async () => {
    const db = mockDb({
      caseRow: { veteranId: 'v1', claimType: 'initial', framingChoice: 'secondary', claimedCondition: 'Obstructive sleep apnea', claimedConditions: [], inServiceEvent: null },
      granted: [{ id: 's1' }],
      problems: [{ problem: 'Obstructive sleep apnea' }],
      docs: [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }],
    });
    const r = await getDraftReadiness(db, 'CLM-1');
    expect(r!.ready).toBe(true);
  });

  it('blocks when there are zero granted SC rows (the Armand case as it stands today)', async () => {
    const db = mockDb({
      caseRow: { veteranId: 'v1', claimType: 'initial', framingChoice: 'secondary', claimedCondition: 'Obstructive sleep apnea', claimedConditions: [], inServiceEvent: null },
      granted: [],
      problems: [{ problem: 'Obstructive sleep apnea' }],
      docs: [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }],
    });
    const r = await getDraftReadiness(db, 'CLM-1');
    expect(r!.ready).toBe(false);
    expect(r!.missing.map((m) => m.key)).toEqual(['sc_conditions']);
  });

  it('#7 reports brainConsulted on a normal chart_ready evaluation (degraded state is observable)', async () => {
    const db = mockDb({
      caseRow: { veteranId: 'v1', claimType: 'initial', framingChoice: 'secondary', claimedCondition: 'Obstructive sleep apnea', claimedConditions: [], inServiceEvent: null },
      granted: [{ id: 's1' }],
      problems: [{ problem: 'Obstructive sleep apnea' }],
      docs: [{ filename: 'Armand Frank DD-214.pdf', docTag: 'Other' }],
    });
    const r = await getDraftReadiness(db, 'CLM-1');
    // The field is surfaced so the FE can render the degraded note. deriveAiViability fails-open INTERNALLY to
    // null (no plan), which is NOT a degraded state — so brainConsulted stays true and no degradedNote is set.
    expect(r!.brainConsulted).toBe(true);
    expect(r!.degradedNote).toBeUndefined();
  });

  it('says "still building" (NOT "documents missing") while extraction is running', async () => {
    const db = mockDb({
      caseRow: { veteranId: 'v1', claimType: 'initial', framingChoice: 'secondary', claimedCondition: 'OSA', claimedConditions: [], inServiceEvent: null },
      granted: [], runStatus: 'running',
    });
    const r = await getDraftReadiness(db, 'CLM-1');
    expect(r!.buildState).toBe('extracting');
    expect(r!.ready).toBe(false);
    expect(r!.missing).toHaveLength(0); // the door does NOT cry "missing" while still building
    expect(r!.summary).toContain('still being built');
  });
});
