// ACCEPTANCE TEST — mechanism-grounded viability verdict (Ryan 2026-07-21).
//
// The SHIP GATE. Deterministic + offline: the GROUNDING (retrieve) is fed as representative chunks and the
// model INVOKE is injected, so no network is touched. What is under test is the PROMPT ASSEMBLY, the
// VERDICT-PARSING, and the additive lead behavior — the burn-pit -> OSA pairing MUST read not/borderline
// viable and name the mechanism gap; the known-good pairings MUST stay viable/borderline (never scared).
//
// The LIVE model judgment (does Opus 4.6 actually read burn-pit->OSA as no-mechanism on real excerpts) is
// validated separately by scripts/smoke-mechanism-viability.mjs, which hits real Bedrock — see that file.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assessMechanismViability,
  parseMechanismVerdict,
  buildMechanismUserContent,
  parseVeteranUpstream,
  sameUpstream,
  deriveDualMechanismVerdict,
  type MechanismInvokeFn,
  type MechanismVerdict,
  type DualMechanismVerdict,
  type MechanismPairing,
} from '../mechanism-viability.js';
import type { RetrieveFn } from '../../advisory/retrieveContract.js';
import {
  withMechanismVerdictLead,
  formatMechanismVerdictLead,
  withMechanismVerdictPlan,
  formatMechanismVerdictPlanLine,
  withDualMechanismVerdict,
  formatDualMechanismAssessmentLead,
  formatDualMechanismPlanLine,
  type SoapNote,
} from '../soap-overview.js';

/** An injected invoke that returns a canned model reply AND captures the exact (system,user) it was given,
 *  so we can assert the prompt carried the fed chunks + claimed + upstream. */
function fakeInvoke(reply: string): { fn: MechanismInvokeFn; calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  const fn: MechanismInvokeFn = async (system, user) => {
    calls.push({ system, user });
    return { text: reply };
  };
  return { fn, calls };
}

// Representative model replies (the shape Opus 4.6 emits under the SYSTEM contract). The offline test locks
// the PIPELINE around these; the live smoke proves the model actually produces the not_viable one.
const BURN_PIT_OSA_REPLY = [
  'VERDICT: not_viable',
  'HEADLINE: Burn-pit / airborne-hazard exposure does not cause or aggravate obstructive sleep apnea.',
  'REASON: Airborne-hazard exposure injures the LOWER airway and lung parenchyma (bronchi/alveoli -> ' +
    'obstructive/restrictive pulmonary disease, constrictive bronchiolitis). OSA is an UPPER-airway ' +
    'collapse disorder driven by pharyngeal anatomy, BMI, and ventilatory-control instability. The ' +
    'excerpts establish no causal or aggravation pathway from lower-airway injury to upper-airway collapse.',
  'COUNTER: A claimant could argue chronic airborne-hazard rhinitis narrows the upper airway, but that is a ' +
    'rhinitis->OSA theory, not burn-pit->OSA, and is not what these excerpts support.',
].join('\n');

const BURN_PIT_OSA_CHUNKS = [
  'Airborne hazards and open burn pits are associated with deployment-related respiratory conditions ' +
    'affecting the lower airways: chronic bronchitis, constrictive bronchiolitis, asthma, and restrictive ' +
    'lung disease. (PMID:30000001)',
  'Obstructive sleep apnea results from repetitive collapse of the pharyngeal (upper) airway; principal ' +
    'risk factors are obesity, craniofacial anatomy, and ventilatory-control instability. (PMID:30000002)',
];

describe('parseMechanismVerdict', () => {
  it('parses a well-formed not_viable reply into all four fields', () => {
    const v = parseMechanismVerdict(BURN_PIT_OSA_REPLY);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe('not_viable');
    expect(v!.headline).toMatch(/burn-pit|airborne/i);
    expect(v!.reason).toMatch(/lower airway|upper[- ]airway|pharyngeal/i);
    expect(v!.strongestCounterargument).toMatch(/rhinitis|counter|argue/i);
  });

  it('accepts "not viable" / "not-viable" spellings and COUNTERARGUMENT label', () => {
    const v = parseMechanismVerdict('VERDICT: not viable\nHEADLINE: x\nREASON: y\nCOUNTERARGUMENT: z');
    expect(v!.verdict).toBe('not_viable');
    expect(v!.strongestCounterargument).toBe('z');
  });

  it('returns null (fail-open) when no VERDICT line is present', () => {
    expect(parseMechanismVerdict('I think this is probably fine, maybe.')).toBeNull();
    expect(parseMechanismVerdict('')).toBeNull();
  });

  it('returns null on an out-of-enum verdict value', () => {
    expect(parseMechanismVerdict('VERDICT: strong\nHEADLINE: x')).toBeNull();
  });
});

describe('assessMechanismViability — prompt is grounded on the fed chunks + pairing', () => {
  it('carries the claimed, upstream, and every fed chunk into the user prompt, plus the assess-stance system', async () => {
    const { fn, calls } = fakeInvoke(BURN_PIT_OSA_REPLY);
    await assessMechanismViability('obstructive sleep apnea', 'burn pit / airborne hazard exposure', BURN_PIT_OSA_CHUNKS, { invoke: fn });
    expect(calls).toHaveLength(1);
    const { system, user } = calls[0];
    // pairing present
    expect(user).toMatch(/obstructive sleep apnea/i);
    expect(user).toMatch(/burn pit \/ airborne hazard exposure/i);
    // both fed excerpts present (grounded, not free-reasoned)
    expect(user).toContain('constrictive bronchiolitis');
    expect(user).toContain('pharyngeal (upper) airway');
    // assess-don't-sell + name-the-counterargument stance
    expect(system).toMatch(/assessor, not an advocate|do NOT sell/i);
    expect(system).toMatch(/counterargument/i);
    // the four-line output contract is instructed
    expect(system).toMatch(/VERDICT:/);
  });

  it('BURN PIT / airborne-hazard -> OSA reads NOT viable and names the lower-airway vs upper-airway gap', async () => {
    const { fn } = fakeInvoke(BURN_PIT_OSA_REPLY);
    const v = await assessMechanismViability('obstructive sleep apnea', 'burn pit / airborne hazard exposure', BURN_PIT_OSA_CHUNKS, { invoke: fn });
    expect(v).not.toBeNull();
    expect(['not_viable', 'borderline']).toContain(v!.verdict); // MUST NOT be a clean "viable"
    expect(v!.reason).toMatch(/lower[- ]airway/i);
    expect(v!.reason).toMatch(/upper[- ]airway|pharyngeal/i);
  });

  it('returns null (fail-open, note unchanged) when the model call throws', async () => {
    const throwing: MechanismInvokeFn = async () => { throw new Error('bedrock timeout'); };
    const v = await assessMechanismViability('osa', 'burn pit', BURN_PIT_OSA_CHUNKS, { invoke: throwing });
    expect(v).toBeNull();
  });

  it('returns null without calling the model when claimed or upstream is empty (nothing to mechanism-check)', async () => {
    const { fn, calls } = fakeInvoke(BURN_PIT_OSA_REPLY);
    expect(await assessMechanismViability('', 'burn pit', [], { invoke: fn })).toBeNull();
    expect(await assessMechanismViability('osa', '   ', [], { invoke: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('KNOWN-GOOD pairings stay viable/borderline (do NOT scare good drafts)', () => {
  const goodCases: Array<{ claimed: string; upstream: string; reply: string; expect: Array<'viable' | 'borderline'> }> = [
    {
      claimed: 'obstructive sleep apnea', upstream: 'PTSD',
      reply: 'VERDICT: viable\nHEADLINE: PTSD is a recognized aggravator of OSA.\nREASON: PTSD hyperarousal, ' +
        'fragmented sleep, and associated weight gain plausibly worsen OSA severity; recognized secondary ' +
        'aggravation pathway under 3.310(b).\nCOUNTER: Causation of the anatomic disorder is weaker than aggravation.',
      expect: ['viable', 'borderline'],
    },
    {
      claimed: 'obstructive sleep apnea', upstream: 'obesity',
      reply: 'VERDICT: viable\nHEADLINE: Obesity is a primary driver of OSA.\nREASON: Increased ' +
        'para-pharyngeal fat load and reduced lung volumes directly promote upper-airway collapse — a ' +
        'core, well-established OSA mechanism.\nCOUNTER: Obesity is often not itself service-connected.',
      expect: ['viable'],
    },
    {
      claimed: 'obstructive sleep apnea', upstream: 'migraine',
      reply: 'VERDICT: borderline\nHEADLINE: Migraine and OSA are associated but the causal direction is ' +
        'weak.\nREASON: Epidemiologic association exists; a direct migraine->OSA anatomic mechanism is not ' +
        'well established — plausible, not a powerhouse.\nCOUNTER: The association may be bidirectional or confounded.',
      expect: ['borderline', 'viable'],
    },
    {
      claimed: 'lumbar radiculopathy', upstream: 'lumbar degenerative disc disease',
      reply: 'VERDICT: viable\nHEADLINE: Lumbar DDD directly causes radiculopathy.\nREASON: Disc ' +
        'degeneration/herniation mechanically compresses the exiting nerve root — the textbook ' +
        'radiculopathy mechanism.\nCOUNTER: Radiculopathy can also stem from stenosis unrelated to DDD.',
      expect: ['viable'],
    },
  ];

  for (const gc of goodCases) {
    it(`${gc.upstream} -> ${gc.claimed} stays ${gc.expect.join('/')}`, async () => {
      const { fn } = fakeInvoke(gc.reply);
      const v = await assessMechanismViability(gc.claimed, gc.upstream, ['(representative supportive excerpt)'], { invoke: fn });
      expect(v).not.toBeNull();
      expect(gc.expect).toContain(v!.verdict);
      expect(v!.verdict).not.toBe('not_viable');
    });
  }
});

// ── The additive SOAP lead (wiring in soap-overview.ts) ────────────────────────────────────────────────
function note(assessment: string): SoapNote {
  return { subjective: 's', objective: 'o', assessment, plan: 'p', confidence: 'moderate', action: 'draft', caveat: null };
}

describe('formatMechanismVerdictLead / withMechanismVerdictLead', () => {
  it('a VIABLE verdict produces NO lead and leaves the note byte-identical (good drafts untouched)', () => {
    const v = { verdict: 'viable' as const, headline: 'ok', reason: 'r', strongestCounterargument: 'c' };
    expect(formatMechanismVerdictLead(v)).toBeNull();
    const n = note('The theory is sound.');
    expect(withMechanismVerdictLead(n, v)).toBe(n); // same reference — untouched
  });

  it('a null verdict leaves the note unchanged (fail-open)', () => {
    const n = note('The theory is sound.');
    expect(withMechanismVerdictLead(n, null)).toBe(n);
  });

  it('a NOT_VIABLE verdict prepends a prominent MECHANISM CHECK lead to the Assessment only', () => {
    const v = parseMechanismVerdict(BURN_PIT_OSA_REPLY)!;
    const n = note('Original assessment prose here.');
    const out = withMechanismVerdictLead(n, v);
    expect(out.assessment.startsWith('⚠ MECHANISM CHECK — NOT SUPPORTABLE AS FRAMED:')).toBe(true);
    expect(out.assessment).toContain('Original assessment prose here.');
    // decision-bearing fields are untouched — this is recommendation-only, never a gate
    expect(out.action).toBe('draft');
    expect(out.confidence).toBe('moderate');
    expect(out.subjective).toBe('s');
    expect(out.objective).toBe('o');
    expect(out.plan).toBe('p');
  });

  it('a BORDERLINE verdict prepends the borderline lead', () => {
    const v = { verdict: 'borderline' as const, headline: 'weak link', reason: 'indirect', strongestCounterargument: 'c' };
    const out = withMechanismVerdictLead(note('body'), v);
    expect(out.assessment.startsWith('⚠ MECHANISM CHECK — BORDERLINE MECHANISM:')).toBe(true);
  });

  it('is idempotent — re-applying the same verdict does not double-prepend', () => {
    const v = parseMechanismVerdict(BURN_PIT_OSA_REPLY)!;
    const once = withMechanismVerdictLead(note('body'), v);
    const twice = withMechanismVerdictLead(once, v);
    expect(twice.assessment).toBe(once.assessment);
  });
});

describe('formatMechanismVerdictPlanLine / withMechanismVerdictPlan (Ryan 2026-07-22 — viability on the Plan)', () => {
  it('a VIABLE verdict adds a supportable/good-to-draft Plan line, preserving the original work-order', () => {
    const v = { verdict: 'viable' as const, headline: 'ok', reason: 'r', strongestCounterargument: 'c' };
    expect(formatMechanismVerdictPlanLine(v)).toContain('good to draft');
    const out = withMechanismVerdictPlan(note('a'), v);
    expect(out.plan.startsWith('Viability: supportable as framed')).toBe(true);
    expect(out.plan).toContain('p'); // the original plan work-order still follows the viability line
  });

  it('a null verdict leaves the note byte-identical (fail-open / flag off)', () => {
    const n = note('a');
    expect(formatMechanismVerdictPlanLine(null)).toBeNull();
    expect(withMechanismVerdictPlan(n, null)).toBe(n); // same reference — untouched
  });

  it('a BORDERLINE verdict prepends the "ask a provider" Plan line', () => {
    const v = { verdict: 'borderline' as const, headline: 'weak', reason: 'indirect', strongestCounterargument: 'c' };
    const out = withMechanismVerdictPlan(note('a'), v);
    expect(out.plan.startsWith('⚠ Viability: BORDERLINE')).toBe(true);
    expect(out.plan).toContain('provider review the viability before drafting');
  });

  it('a NOT_VIABLE verdict prepends the "not supportable" Plan line and touches ONLY the plan', () => {
    const v = parseMechanismVerdict(BURN_PIT_OSA_REPLY)!;
    const out = withMechanismVerdictPlan(note('assessment prose'), v);
    expect(out.plan.startsWith('⚠ Viability: NOT SUPPORTABLE AS FRAMED')).toBe(true);
    // PLAN-only: the Assessment, decision fields, and other sections are untouched by THIS fold
    expect(out.assessment).toBe('assessment prose');
    expect(out.action).toBe('draft');
    expect(out.confidence).toBe('moderate');
    expect(out.subjective).toBe('s');
    expect(out.objective).toBe('o');
  });

  it('is idempotent — re-applying the same verdict does not double-prepend', () => {
    const v = parseMechanismVerdict(BURN_PIT_OSA_REPLY)!;
    const once = withMechanismVerdictPlan(note('a'), v);
    const twice = withMechanismVerdictPlan(once, v);
    expect(twice.plan).toBe(once.plan);
  });
});

describe('buildMechanismUserContent handles the no-excerpts case gracefully', () => {
  it('notes when no excerpts were retrieved (still lets the model judge)', () => {
    const u = buildMechanismUserContent('osa', 'burn pit', []);
    expect(u).toMatch(/no literature excerpts were retrieved/i);
  });
});

// ── DUAL VERDICT (Ryan 2026-07-22) — the veteran's OWN theory alongside the route-picker LEAD ─────────────

// The veteran-upstream extractor's reply shape (a JSON object grounded in the statement).
const LYNAUGH_STATEMENT = 'Exposure to burn pits in the gulf war';
const VET_BURN_PIT_REPLY = '{"upstream":"burn-pit exposure","echo":"Exposure to burn pits","framing":"direct"}';
// A not_viable reply for the LEAD pairing (Impaired Hearing -> OSA).
const HEARING_OSA_REPLY = [
  'VERDICT: not_viable',
  'HEADLINE: Impaired hearing does not cause or aggravate obstructive sleep apnea.',
  'REASON: Sensorineural hearing loss is a cochlear / auditory-nerve disorder; OSA is an upper-airway ' +
    'anatomic and ventilatory-control disorder. No physiologic pathway connects auditory dysfunction to ' +
    'pharyngeal airway collapse.',
  'COUNTER: Both are common in aging veterans, but co-occurrence is not a mechanism.',
].join('\n');

describe('parseVeteranUpstream — grounded extraction of the veteran\'s OWN stated cause', () => {
  it('extracts a burn-pit EXPOSURE upstream (the case veteran-theory-ai structurally cannot supply)', () => {
    const v = parseVeteranUpstream(VET_BURN_PIT_REPLY, LYNAUGH_STATEMENT);
    expect(v).not.toBeNull();
    expect(v!.upstream).toBe('burn-pit exposure');
    expect(v!.framing).toBe('direct');
  });

  it('extracts a secondary CONDITION upstream', () => {
    const v = parseVeteranUpstream('{"upstream":"PTSD","echo":"because of the PTSD","framing":"secondary"}', 'my sleep apnea is because of the PTSD from deployment');
    expect(v!.upstream).toBe('PTSD');
    expect(v!.framing).toBe('secondary');
  });

  it('drops an UNGROUNDED echo (echo not in the statement) → null', () => {
    expect(parseVeteranUpstream('{"upstream":"asbestos exposure","echo":"exposed to asbestos aboard ship","framing":"direct"}', LYNAUGH_STATEMENT)).toBeNull();
  });

  it('drops an upstream whose tokens are NOT corroborated by the statement (Ankle defense) → null', () => {
    // echo is verbatim, but the named upstream ("ankle") shares no significant token with the statement.
    expect(parseVeteranUpstream('{"upstream":"ankle instability","echo":"Exposure to burn pits","framing":"secondary"}', LYNAUGH_STATEMENT)).toBeNull();
  });

  it('returns null on no-cause / no-JSON / null upstream', () => {
    expect(parseVeteranUpstream('{"upstream":null,"echo":null,"framing":"unclear"}', LYNAUGH_STATEMENT)).toBeNull();
    expect(parseVeteranUpstream('I could not determine a cause.', LYNAUGH_STATEMENT)).toBeNull();
  });
});

describe('sameUpstream — collapse to ONE verdict when the pairings match', () => {
  it('treats "hearing loss" ~ "Impaired Hearing" as the SAME pairing (shared significant token)', () => {
    expect(sameUpstream('hearing loss', 'Impaired Hearing')).toBe(true);
  });
  it('treats burn-pit exposure vs Impaired Hearing as DIFFERENT pairings', () => {
    expect(sameUpstream('burn-pit exposure', 'Impaired Hearing')).toBe(false);
  });
});

// A minimal empty retriever so deriveMechanismVerdict never touches pg / the vendor tree in tests.
const emptyRetrieve: RetrieveFn = () => ({ status: 'empty', mode_ran: [], errors: [], chunks: [], notes: [] });

function mkVerdict(band: MechanismVerdict['verdict'], headline: string, reason: string): MechanismVerdict {
  return { verdict: band, headline, reason, strongestCounterargument: 'c' };
}
function mkPairing(upstream: string, band: MechanismVerdict['verdict'], headline = 'h', reason = 'r'): MechanismPairing {
  return { upstream, verdict: mkVerdict(band, headline, reason) };
}
/** Two-arg note builder (the file-level `note()` only takes an assessment) — dual tests set the plan too. */
function dnote(assessment: string, plan = 'p'): SoapNote {
  return { subjective: 's', objective: 'o', assessment, plan, confidence: 'moderate', action: 'draft', caveat: null };
}
describe('deriveDualMechanismVerdict — orchestration (flag-gated, injected invokers, offline)', () => {
  afterEach(() => vi.unstubAllEnvs());

  // Branch the mechanism invoker on the UPSTREAM carried in the user content, so the lead and veteran calls
  // each get their own per-pairing reply.
  function mechInvoke(counter: { n: number }): MechanismInvokeFn {
    return async (_system, user) => {
      counter.n += 1;
      if (/burn[- ]?pit/i.test(user)) return { text: BURN_PIT_OSA_REPLY };
      return { text: HEARING_OSA_REPLY };
    };
  }

  it('flag OFF → both null, NO model calls (byte-identical note downstream)', async () => {
    vi.stubEnv('SOAP_MECHANISM_VERDICT_ENABLED', 'false');
    const mech = { n: 0 };
    const vet = { n: 0 };
    const dual = await deriveDualMechanismVerdict('obstructive sleep apnea', 'Impaired Hearing', LYNAUGH_STATEMENT, {
      mechanismInvoke: mechInvoke(mech),
      veteranInvoke: async () => { vet.n += 1; return { text: VET_BURN_PIT_REPLY }; },
      retrieve: emptyRetrieve,
    });
    expect(dual).toEqual({ claimed: 'obstructive sleep apnea', lead: null, veteran: null });
    expect(mech.n).toBe(0);
    expect(vet.n).toBe(0);
  });

  it('LYNAUGH: veteran theory (burn-pit) DIFFERS from the lead (Impaired Hearing) → BOTH assessed', async () => {
    vi.stubEnv('SOAP_MECHANISM_VERDICT_ENABLED', 'true');
    const mech = { n: 0 };
    const dual = await deriveDualMechanismVerdict('obstructive sleep apnea', 'Impaired Hearing', LYNAUGH_STATEMENT, {
      mechanismInvoke: mechInvoke(mech),
      veteranInvoke: async () => ({ text: VET_BURN_PIT_REPLY }),
      retrieve: emptyRetrieve,
    });
    expect(dual.lead).not.toBeNull();
    expect(dual.lead!.upstream).toBe('Impaired Hearing');
    expect(dual.lead!.verdict.verdict).toBe('not_viable');
    expect(dual.veteran).not.toBeNull();
    expect(dual.veteran!.upstream).toBe('burn-pit exposure');
    expect(dual.veteran!.verdict.verdict).toBe('not_viable');
    expect(mech.n).toBe(2); // one grounded verdict per pairing
  });

  it('SAME pairing (veteran ~ lead) → veteran stays null → single-lead only', async () => {
    vi.stubEnv('SOAP_MECHANISM_VERDICT_ENABLED', 'true');
    const mech = { n: 0 };
    const dual = await deriveDualMechanismVerdict('obstructive sleep apnea', 'Impaired Hearing', 'my hearing loss caused my sleep apnea', {
      mechanismInvoke: mechInvoke(mech),
      veteranInvoke: async () => ({ text: '{"upstream":"hearing loss","echo":"my hearing loss","framing":"secondary"}' }),
      retrieve: emptyRetrieve,
    });
    expect(dual.lead).not.toBeNull();
    expect(dual.veteran).toBeNull(); // same pairing → no redundant second verdict
    expect(mech.n).toBe(1); // only the lead verdict ran
  });

  it('fail-open: veteran extraction throws → veteran null, lead verdict still returned', async () => {
    vi.stubEnv('SOAP_MECHANISM_VERDICT_ENABLED', 'true');
    const dual = await deriveDualMechanismVerdict('obstructive sleep apnea', 'Impaired Hearing', LYNAUGH_STATEMENT, {
      mechanismInvoke: mechInvoke({ n: 0 }),
      veteranInvoke: async () => { throw new Error('bedrock timeout'); },
      retrieve: emptyRetrieve,
    });
    expect(dual.lead).not.toBeNull();
    expect(dual.veteran).toBeNull();
  });
});

describe('withDualMechanismVerdict / dual formatters (render)', () => {
  const CLAIMED = 'obstructive sleep apnea';

  it('BYTE-IDENTICAL to the single-lead path when there is no distinct veteran theory', () => {
    const leadV = mkVerdict('not_viable', 'lead headline', 'lead reason');
    const dual: DualMechanismVerdict = { claimed: CLAIMED, lead: { upstream: 'Impaired Hearing', verdict: leadV }, veteran: null };
    const n = dnote('Original assessment.', 'Original plan.');
    const viaDual = withDualMechanismVerdict(n, dual);
    const viaSingle = withMechanismVerdictPlan(withMechanismVerdictLead(n, leadV), leadV);
    expect(viaDual).toEqual(viaSingle);
  });

  it('null dual leaves the note untouched (same reference)', () => {
    const n = dnote('a');
    expect(withDualMechanismVerdict(n, null)).toBe(n);
  });

  it('both NOT_VIABLE (Lynaugh) → both clauses on the Assessment + not-supportable Plan; decision fields untouched', () => {
    const dual: DualMechanismVerdict = {
      claimed: CLAIMED,
      lead: mkPairing('Impaired Hearing', 'not_viable', 'Impaired hearing does not cause OSA.', 'auditory vs upper-airway'),
      veteran: mkPairing('burn-pit exposure', 'not_viable', 'Burn-pit exposure does not cause OSA.', 'lower-airway vs upper-airway'),
    };
    const out = withDualMechanismVerdict(dnote('Base assessment.', 'Base plan.'), dual);
    expect(out.assessment.startsWith("⚠ MECHANISM CHECK — VETERAN'S THEORY (burn-pit exposure → obstructive sleep apnea): NOT SUPPORTABLE")).toBe(true);
    expect(out.assessment).toContain('LEAD ALTERNATIVE ASSESSED (Impaired Hearing → obstructive sleep apnea): NOT SUPPORTABLE');
    expect(out.assessment).toContain('Base assessment.');
    expect(out.plan.startsWith('⚠ Viability: NOT SUPPORTABLE AS FRAMED')).toBe(true);
    expect(out.plan).toContain('neither');
    expect(out.plan).toContain('Base plan.');
    // recommendation-only — decision fields untouched
    expect(out.action).toBe('draft');
    expect(out.confidence).toBe('moderate');
    expect(out.subjective).toBe('s');
    expect(out.objective).toBe('o');
  });

  it('veteran NOT_VIABLE but lead VIABLE → both shown; Plan says a supportable alternative exists', () => {
    const dual: DualMechanismVerdict = {
      claimed: CLAIMED,
      lead: mkPairing('obesity', 'viable', 'Obesity drives OSA.', 'para-pharyngeal fat load'),
      veteran: mkPairing('burn-pit exposure', 'not_viable', 'Burn-pit exposure does not cause OSA.', 'lower vs upper airway'),
    };
    const out = withDualMechanismVerdict(dnote('Base.', 'Plan.'), dual);
    // both pairings appear (the RN sees the veteran's theory WAS addressed AND that a supportable path exists)
    expect(out.assessment).toContain("VETERAN'S THEORY (burn-pit exposure → obstructive sleep apnea): NOT SUPPORTABLE");
    expect(out.assessment).toContain('LEAD ALTERNATIVE ASSESSED (obesity → obstructive sleep apnea): SUPPORTABLE');
    expect(out.plan).toContain('is supportable, but');
    expect(out.plan).toContain('confirm which theory to plead');
  });

  it('BOTH VIABLE → no Assessment warning (never scare a sound draft) but a supportable Plan line', () => {
    const dual: DualMechanismVerdict = {
      claimed: CLAIMED,
      lead: mkPairing('obesity', 'viable'),
      veteran: mkPairing('PTSD', 'viable'),
    };
    const out = withDualMechanismVerdict(dnote('Base assessment.', 'Base plan.'), dual);
    expect(out.assessment).toBe('Base assessment.'); // no warning prepended
    expect(formatDualMechanismAssessmentLead(dual)).toBeNull();
    expect(out.plan.startsWith('Viability: supportable as framed')).toBe(true);
  });

  it('dual folds are idempotent (no double-prepend on re-apply)', () => {
    const dual: DualMechanismVerdict = {
      claimed: CLAIMED,
      lead: mkPairing('Impaired Hearing', 'not_viable'),
      veteran: mkPairing('burn-pit exposure', 'not_viable'),
    };
    const once = withDualMechanismVerdict(dnote('b', 'q'), dual);
    const twice = withDualMechanismVerdict(once, dual);
    expect(twice.assessment).toBe(once.assessment);
    expect(twice.plan).toBe(once.plan);
  });

  it('formatDualMechanismPlanLine returns null when there is no distinct veteran theory', () => {
    expect(formatDualMechanismPlanLine({ claimed: CLAIMED, lead: mkPairing('x', 'not_viable'), veteran: null })).toBeNull();
  });
});
