// LIVE-Bedrock smoke for the DIRECT-SC viability verdict (Ryan 2026-07-23). Hits the real advisory model
// (Opus 4.6) — run with AWS creds. Proves the MODEL, not just the pipeline: the owner anchors must hold —
// witnessed-death → PTSD = viable, ankle → diabetes (direct) = not_viable — and the records-gap / redirect
// cases must land borderline. Mirrors backend/scripts/smoke-mechanism-viability.ts.
//
//   npx tsx backend/scripts/smoke-direct-viability.ts
//
// The #9 burn-pit → constrictive bronchiolitis case is the deliberate mirror of the mechanism smoke's
// burn-pit → OSA = not_viable: same exposure, RIGHT organ here (lower airway) → viable. Together they cover
// the burn-pit veteran completely.

import { assessDirectScViability, type DirectScChartFacts } from '../src/services/direct-viability.js';

type Band = 'viable' | 'borderline' | 'not_viable';
const EV = (name: string, span: string): DirectScChartFacts['inServiceEvents'] => [{ event_canonical: name, evidence_span: span }];

interface Case { n: number; label: string; claimed: string; facts: DirectScChartFacts; want: Band[]; hard?: boolean }

const cases: Case[] = [
  { n: 1, hard: true, label: 'witnessed combat death -> PTSD (ANCHOR)', claimed: 'PTSD', want: ['viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('witnessed combat death', 'saw squadmate killed by IED in Iraq'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'I watched my friend get killed by the blast and cannot stop reliving it' } },
  { n: 2, hard: true, label: 'ankle sprain -> diabetes, DIRECT (ANCHOR)', claimed: 'Type 2 Diabetes Mellitus', want: ['not_viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('right ankle sprain', 'twisted ankle on a training run, treated at sick call'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'my diabetes started because of the ankle injury I got in the service' } },
  { n: 3, label: 'acoustic trauma -> tinnitus', claimed: 'Tinnitus', want: ['viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('acoustic trauma', 'artillery crew, routine unprotected exposure to howitzer fire'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'my ears have rung constantly since the gun line' } },
  { n: 4, label: 'documented knee injury -> same-knee OA', claimed: 'Right Knee Osteoarthritis', want: ['viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('right knee injury', 'documented right knee injury at sick call and on the MEB'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'I hurt my right knee in a fall during a field exercise' } },
  { n: 5, label: 'back strain + documented continuity -> lumbar DDD', claimed: 'Lumbar Degenerative Disc Disease', want: ['viable', 'borderline'],
    facts: { currentDxPresent: true, inServiceEvents: EV('low back strain', 'in-service lumbar strain treated in the field'), continuityEvidence: 'STRs and post-service records document continuous low back pain from separation to the present with no symptom-free gap', upstreamScIfAny: null, veteranStatement: 'my back has hurt every day since I strained it in service' } },
  { n: 6, label: 'back strain, NO documented continuity -> borderline', claimed: 'Lumbar Degenerative Disc Disease', want: ['borderline'],
    facts: { currentDxPresent: true, inServiceEvents: EV('low back strain', 'single in-service lumbar strain, then no back complaints for years'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'my back hurts now' } },
  { n: 7, label: 'PTSD claimed, NO current dx -> records-gap borderline', claimed: 'PTSD', want: ['borderline'],
    facts: { currentDxPresent: false, inServiceEvents: EV('claimed stressor', 'veteran describes a stressor but it is unverified and there is no PTSD diagnosis of record'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'bad things happened over there and I have not been the same' } },
  { n: 8, label: 'MST with markers -> PTSD', claimed: 'PTSD', want: ['viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('military sexual trauma', 'MST with corroborating markers per 38 CFR 3.304(f)(5): a documented request for transfer and a drop in performance'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'I was assaulted during my service and asked to transfer right after' } },
  { n: 9, label: 'burn-pit -> constrictive bronchiolitis (RIGHT organ)', claimed: 'Constrictive Bronchiolitis', want: ['viable'],
    facts: { currentDxPresent: true, inServiceEvents: EV('burn-pit / airborne-hazard exposure', 'documented daily proximity to open burn pits at a forward base'), continuityEvidence: null, upstreamScIfAny: null, veteranStatement: 'I breathed burn pit smoke every day and now I cannot catch my breath' } },
  { n: 10, label: 'OSA "from my SC PTSD", DIRECT -> redirect borderline', claimed: 'Obstructive Sleep Apnea', want: ['borderline'],
    facts: { currentDxPresent: true, inServiceEvents: [], continuityEvidence: null, upstreamScIfAny: 'PTSD', veteranStatement: 'my sleep apnea is caused by my service-connected PTSD' } },
];

let pass = 0; let hardFail = 0;
for (const c of cases) {
  const v = await assessDirectScViability(c.claimed, c.facts, []);
  const ok = !!v && c.want.includes(v.verdict); if (ok) pass++; else if (c.hard) hardFail++;
  console.log(`\n=== #${c.n} ${c.label} ===`);
  console.log(`  verdict: ${v ? v.verdict : 'NULL'} (want ${c.want.join('/')})  ${ok ? 'PASS' : 'FAIL'}${c.hard ? '  [HARD ANCHOR]' : ''}`);
  if (v) { console.log('  headline: ' + v.headline); console.log('  reason: ' + v.reason.slice(0, 260)); }
}
console.log(`\n${pass}/${cases.length} passed; hard-anchor failures: ${hardFail}`);
if (hardFail > 0) { console.log('SHIP GATE: FAIL (an owner anchor regressed)'); process.exit(1); }
console.log(pass === cases.length ? 'SHIP GATE: PASS' : `SHIP GATE: ${pass}/${cases.length} — review the non-anchor misses before flipping the flag`);
