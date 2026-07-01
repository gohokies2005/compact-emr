// Objective hard-data MEASUREMENTS for the SOAP Objective (#63, Dr. Kasky). The SOAP synthesizer fills a
// structured `measurements[]` from the chart it is already given (the single SOAP call), and these pin the
// pure coercer/grounding/threading that turns the model's raw tool output into safe, grounded display data:
//   - a VALID measurement is kept with its label/value/unit/qualifier/date and an assembled `display`;
//   - a MALFORMED row (no label / no value / no number) is dropped, never crashes;
//   - GROUNDING: a value whose number is NOT in the chart context is dropped (anti-fabrication — a value the
//     model invented for the condition cannot reach the Objective);
//   - a date/qualifier not in the context is nulled (date anti-fabrication, mirrors chart-extract);
//   - NONE → graceful empty [] and the Objective prose is unchanged.
import { describe, it, expect } from 'vitest';
import {
  coerceMeasurements,
  withMeasurementsInObjective,
  ensureSeverityMeasurements,
  extractSeverityMeasurementsFromContext,
  __renderContextForTest,
} from '../soap-overview.js';

// A realistic rendered-context excerpt (what renderContext would feed the model): a sleep-study + CPAP report.
const CONTEXT = [
  'Claimed condition: Obstructive sleep apnea',
  'Extracted records (source material):',
  '[p.31] Polysomnogram 4/2024: AHI 28.4 events/hr (diagnostic). On CPAP at 10 cm H2O, AHI 3.1 events/hr. Lowest SpO2 81%.',
  '[p.44] CPAP compliance report: average use 6.2 hours/night; used on 88% of nights.',
].join('\n');

describe('coerceMeasurements — coerce + ground', () => {
  it('keeps a valid grounded measurement with unit, qualifier, date, and an assembled display', () => {
    const out = coerceMeasurements(
      [{ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic', date: '4/2024' }],
      CONTEXT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic', date: '4/2024' });
    expect(out[0]!.display).toBe('AHI 28.4 events/hr (diagnostic, 4/2024)');
  });

  it('accepts a numeric value and a dimensionless score (PHQ-9-style, no unit)', () => {
    const ctx = 'PHQ-9 administered 3/2024: score 18 (moderately severe).';
    const out = coerceMeasurements([{ label: 'PHQ-9', value: 18 }], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('18');
    expect(out[0]!.unit).toBeNull();
    expect(out[0]!.display).toBe('PHQ-9 18');
  });

  it('grounds a compound value (BP 142/88) only when BOTH numbers are in the context', () => {
    const ctx = 'Vitals: blood pressure 142/88 mmHg.';
    const ok = coerceMeasurements([{ label: 'Blood pressure', value: '142/88', unit: 'mmHg' }], ctx);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.display).toBe('Blood pressure 142/88 mmHg');
    // a fabricated second number (90 not in chart) drops the whole row
    const bad = coerceMeasurements([{ label: 'Blood pressure', value: '142/90', unit: 'mmHg' }], ctx);
    expect(bad).toHaveLength(0);
  });

  it('DROPS a value whose number is not in the chart context (anti-fabrication)', () => {
    const out = coerceMeasurements([{ label: 'AHI', value: '52.7', unit: 'events/hr', qualifier: 'diagnostic' }], CONTEXT);
    expect(out).toHaveLength(0);
  });

  it('DROPS malformed rows (no label, no value, no number) without crashing', () => {
    const out = coerceMeasurements(
      [
        { value: '28.4', unit: 'events/hr' },        // no label
        { label: 'AHI' },                            // no value
        { label: 'Note', value: 'severe' },          // value has no number
        null,                                        // not an object
        'garbage',                                   // not an object
      ],
      CONTEXT,
    );
    expect(out).toEqual([]);
  });

  it('NULLs a date/qualifier that is not present in the context (date anti-fabrication)', () => {
    const out = coerceMeasurements(
      [{ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'while standing', date: '1/2099' }],
      CONTEXT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBeNull();        // 1/2099 not in chart → nulled (value still grounded)
    expect(out[0]!.qualifier).toBeNull();   // "while standing" not in chart → nulled
    expect(out[0]!.display).toBe('AHI 28.4 events/hr');
  });

  it('dedups on (label, value, qualifier) and tolerates the integer part of a decimal', () => {
    const ctx = 'CPAP residual AHI 3 events/hr.';
    const out = coerceMeasurements(
      [
        { label: 'AHI', value: '3.0', unit: 'events/hr', qualifier: 'on CPAP' }, // integer part 3 is in ctx
        { label: 'AHI', value: '3.0', unit: 'events/hr', qualifier: 'on CPAP' }, // exact dup
      ],
      ctx,
    );
    expect(out).toHaveLength(1);
  });

  // ── PRIORITY ORDERING (#63, Dr. Kasky 2026-06-30) ──
  // The OSA nightmare: the model surfaces sleep-ARCHITECTURE metrics (TST/efficiency/REM latency/N3) + BMI and
  // omits or buries AHI — THE severity index. Fix: AHI leads, RDI second, above the architecture metrics, even
  // when the model emits them in the wrong order, and even when they arrive late (must survive the cap).
  it('reorders so AHI is FIRST and RDI SECOND above architecture metrics, regardless of emitted order', () => {
    const ctx = [
      'Polysomnogram 4/2024 (diagnostic): total sleep time 388 min, sleep efficiency 84%, REM latency 96 min,',
      'N3 sleep 12%, BMI 34, RDI 33.1 events/hr, AHI 28.4 events/hr.',
    ].join(' ');
    const out = coerceMeasurements(
      [
        { label: 'Total sleep time', value: '388', unit: 'min', qualifier: 'diagnostic' },
        { label: 'Sleep efficiency', value: '84', unit: '%', qualifier: 'diagnostic' },
        { label: 'REM latency', value: '96', unit: 'min', qualifier: 'diagnostic' },
        { label: 'N3 sleep', value: '12', unit: '%', qualifier: 'diagnostic' },
        { label: 'BMI', value: '34', unit: 'kg/m2' },
        { label: 'RDI', value: '33.1', unit: 'events/hr', qualifier: 'diagnostic' },
        { label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic' }, // emitted LAST
      ],
      ctx,
    );
    const labels = out.map((m) => m.label);
    expect(labels[0]).toBe('AHI');
    expect(labels[1]).toBe('RDI');
    // the architecture metrics all rank after AHI/RDI
    expect(labels.indexOf('AHI')).toBeLessThan(labels.indexOf('Total sleep time'));
    expect(labels.indexOf('RDI')).toBeLessThan(labels.indexOf('Sleep efficiency'));
  });

  it('AHI survives the cap even when the model emits it after 8 architecture rows (sort-before-cap)', () => {
    const arch = Array.from({ length: 8 }, (_, i) => `arch metric M${i} value ${i} in the diagnostic study.`).join(' ');
    const ctx = `${arch} Sleep study: AHI 28.4 events/hr.`;
    const raw = [
      ...Array.from({ length: 8 }, (_, i) => ({ label: `M${i}`, value: String(i) })),
      { label: 'AHI', value: '28.4', unit: 'events/hr' }, // 9th, would be capped out without priority-before-cap
    ];
    const out = coerceMeasurements(raw, ctx);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out[0]!.label).toBe('AHI'); // priority pulls it to the front AND inside the cap
  });

  it('non-sleep measurements keep their emitted order (no regression for BP/A1c charts)', () => {
    const ctx = 'Vitals: blood pressure 142/88 mmHg. Labs: HbA1c 7.1%, fasting glucose 138 mg/dL.';
    const out = coerceMeasurements(
      [
        { label: 'Blood pressure', value: '142/88', unit: 'mmHg' },
        { label: 'HbA1c', value: '7.1', unit: '%' },
        { label: 'Fasting glucose', value: '138', unit: 'mg/dL' },
      ],
      ctx,
    );
    expect(out.map((m) => m.label)).toEqual(['Blood pressure', 'HbA1c', 'Fasting glucose']);
  });

  it('returns [] for a null / non-array tool input (graceful empty)', () => {
    expect(coerceMeasurements(undefined, CONTEXT)).toEqual([]);
    expect(coerceMeasurements(null, CONTEXT)).toEqual([]);
    expect(coerceMeasurements({ not: 'an array' }, CONTEXT)).toEqual([]);
  });

  it('caps at 8 measurements even when more are grounded', () => {
    const ctx = Array.from({ length: 12 }, (_, i) => `Metric M${i} value ${i}.`).join(' ');
    const raw = Array.from({ length: 12 }, (_, i) => ({ label: `M${i}`, value: String(i) }));
    const out = coerceMeasurements(raw, ctx);
    expect(out.length).toBeLessThanOrEqual(8);
  });
});

// ── LABEL-PROXIMITY grounding (QA AI-SME, 2026-06-25) ──
// "The number exists somewhere" is not "the number belongs to THIS label." A real-but-MISLABELED value must
// be DROPPED, and an integer must not stand in for a competing decimal.
describe('coerceMeasurements — label-proximity grounding (anti-transposition)', () => {
  it('grounds AHI 28.4 when 28.4 sits next to "AHI" in the chart', () => {
    const ctx = 'Polysomnogram 4/2024: AHI 28.4 events/hr (diagnostic).';
    const out = coerceMeasurements([{ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic' }], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('28.4');
  });

  // THE transposition the AI-SME flagged: the chart's 28.4 is the EJECTION FRACTION, and the model mislabels
  // it as AHI. The number exists, but NOT near "AHI"/"apnea"/"hypopnea" → it must be DROPPED.
  it('DROPS the AHI-vs-EF transposition (28.4 is the ejection fraction, far from any apnea token)', () => {
    const ctx = [
      'Echocardiogram 2/2024: left ventricular ejection fraction 28.4%, mildly reduced.',
      'Sleep history: snoring reported; no formal sleep study on file.',
    ].join(' ');
    const out = coerceMeasurements([{ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic' }], ctx);
    expect(out).toHaveLength(0);
  });

  // ...but the SAME 28.4, correctly labeled as the ejection fraction, DOES ground (proves we did not just
  // hard-ban the value — the label match is what matters).
  it('grounds the SAME 28.4 when correctly labeled as ejection fraction', () => {
    const ctx = 'Echocardiogram 2/2024: left ventricular ejection fraction 28.4%, mildly reduced.';
    const out = coerceMeasurements([{ label: 'Ejection fraction', value: '28.4', unit: '%' }], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('28.4');
  });

  it('"3.0" still grounds against a chart that wrote a lone "3" near the label (fallback preserved)', () => {
    const ctx = 'CPAP residual AHI 3 events/hr.';
    const out = coerceMeasurements([{ label: 'AHI', value: '3.0', unit: 'events/hr', qualifier: 'on CPAP' }], ctx);
    expect(out).toHaveLength(1);
  });

  // TIGHTENED integer fallback: "28.4" must NOT ground on a lone "28" when a COMPETING decimal (28.7) is the
  // chart's real reading for that integer — the model's 28.4 is then an invention, not the chart's 28.7.
  it('"28.4" does NOT ground when the chart only has a lone "28" with a competing decimal (28.7)', () => {
    const ctx = 'AHI 28.7 events/hr on the diagnostic study; 28 nights of CPAP data reviewed.';
    const out = coerceMeasurements([{ label: 'AHI', value: '28.4', unit: 'events/hr' }], ctx);
    expect(out).toHaveLength(0);
  });

  it('blood pressure 142/88 grounds near "blood pressure"; a fabricated 142/90 still drops', () => {
    const ctx = 'Vitals on 5/2024: blood pressure 142/88 mmHg, heart rate 72.';
    expect(coerceMeasurements([{ label: 'Blood pressure', value: '142/88', unit: 'mmHg' }], ctx)).toHaveLength(1);
    expect(coerceMeasurements([{ label: 'Blood pressure', value: '142/90', unit: 'mmHg' }], ctx)).toHaveLength(0);
  });

  it('HbA1c 7.1% grounds via the a1c synonym group', () => {
    const ctx = 'Labs 3/2024: HbA1c 7.1%, fasting glucose 138 mg/dL.';
    const out = coerceMeasurements([{ label: 'A1c', value: '7.1', unit: '%' }], ctx);
    expect(out).toHaveLength(1);
  });

  it('PHQ-9 score grounds even when the number is a few words from the label', () => {
    const ctx = 'PHQ-9 administered 3/2024: total score 18 (moderately severe).';
    const out = coerceMeasurements([{ label: 'PHQ-9', value: '18' }], ctx);
    expect(out).toHaveLength(1);
  });

  it('fail-open: a label with no anchorable tokens drops rather than crashing', () => {
    const ctx = 'AHI 28.4 events/hr.';
    // value exists in ctx but the label has no usable letters and there is no unit → cannot anchor → drop.
    const out = coerceMeasurements([{ label: '42', value: '28.4' }], ctx);
    expect(out).toHaveLength(0);
  });

  it('a measurement far (>window) from its label is dropped even though the value exists', () => {
    const ctx = `AHI is discussed here. ${'x'.repeat(200)} The figure 28.4 appears in an unrelated paragraph.`;
    const out = coerceMeasurements([{ label: 'AHI', value: '28.4', unit: 'events/hr' }], ctx);
    expect(out).toHaveLength(0);
  });
});

describe('withMeasurementsInObjective — threading into prose (plain-text consumers)', () => {
  it('appends a labeled measurements sentence when present', () => {
    const ms = coerceMeasurements(
      [
        { label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic', date: '4/2024' },
        { label: 'CPAP nightly usage', value: '6.2', unit: 'hours/night' },
      ],
      CONTEXT,
    );
    const objective = withMeasurementsInObjective('OSA is confirmed on sleep study.', ms);
    expect(objective).toContain('OSA is confirmed on sleep study.');
    expect(objective).toContain('Objective measurements: AHI 28.4 events/hr (diagnostic, 4/2024); CPAP nightly usage 6.2 hours/night.');
  });

  it('is a no-op (prose unchanged) when there are no measurements', () => {
    const prose = 'OSA is confirmed on sleep study. All records were reviewed.';
    expect(withMeasurementsInObjective(prose, [])).toBe(prose);
  });
});

// ── DETERMINISTIC SEVERITY BACKSTOP (Dr. Kasky, Robert Foster OSA collapse-to-BMI 2026-06-30) ──
// The reliability failure: on a COMPLETE (large) chart the SOAP synthesizer emitted only {BMI} and DROPPED the
// polysomnogram AHI/RDI the chart contained, so the Objective collapsed to "BMI 49.7" — thinner than the
// provisional note. The priority sort only reorders what the model emitted; it cannot recover a dropped number.
// ensureSeverityMeasurements is the guarantee: if AHI/RDI are present-and-label-grounded in the exact context
// the model saw, they cannot be dropped — while a non-sleep chart (no "AHI …number") can never gain an invented
// AHI (anti-fabrication by construction).
const PSG_CTX = [
  'Claimed condition: Obstructive sleep apnea',
  'Extracted records (source material):',
  '[Sleep p3] Polysomnogram 4/2024: AHI 28.4 events/hr (diagnostic); RDI 33.1 events/hr; lowest SpO2 81%.',
  '[Clinic p1] BMI 49.7 kg/m2 (class III obesity).',
].join('\n');

describe('extractSeverityMeasurementsFromContext — deterministic, grounded, non-inventing', () => {
  it('pulls AHI and RDI verbatim from a PSG context', () => {
    const ms = extractSeverityMeasurementsFromContext(PSG_CTX);
    expect(ms.map((m) => m.label).sort()).toEqual(['AHI', 'RDI']);
    expect(ms.find((m) => m.label === 'AHI')!.value).toBe('28.4');
    expect(ms.find((m) => m.label === 'RDI')!.value).toBe('33.1');
  });

  it('captures BOTH the diagnostic and the on-CPAP AHI as separate readings', () => {
    const ctx = 'Polysomnogram: AHI 28.4 events/hr (diagnostic). On CPAP at 10 cm H2O, AHI 3.1 events/hr.';
    const ahiVals = extractSeverityMeasurementsFromContext(ctx).filter((m) => m.label === 'AHI').map((m) => m.value);
    expect(ahiVals.sort()).toEqual(['28.4', '3.1'].sort());
  });

  it('invents NOTHING when the chart mentions a sleep study but reports no AHI number', () => {
    const ctx = '[Sleep p1] Sleep study ordered; polysomnogram pending. Patient reports loud snoring and witnessed apneas.';
    expect(extractSeverityMeasurementsFromContext(ctx)).toEqual([]);
  });

  it('invents NOTHING on a non-sleep chart', () => {
    expect(extractSeverityMeasurementsFromContext('Vitals: blood pressure 142/88 mmHg. HbA1c 7.1%.')).toEqual([]);
  });
});

describe('ensureSeverityMeasurements — guarantee AHI/RDI cannot be dropped', () => {
  it('RECOVERS the collapse-to-BMI: model emitted only BMI → AHI first, RDI second, BMI after', () => {
    const modelOnlyBmi = coerceMeasurements([{ label: 'BMI', value: '49.7', unit: 'kg/m2' }], PSG_CTX);
    expect(modelOnlyBmi.map((m) => m.label)).toEqual(['BMI']); // the exact failure the screenshot showed
    const out = ensureSeverityMeasurements(modelOnlyBmi, PSG_CTX);
    const labels = out.map((m) => m.label);
    expect(labels[0]).toBe('AHI');
    expect(labels[1]).toBe('RDI');
    expect(labels).toContain('BMI');
    expect(out.find((m) => m.label === 'AHI')!.value).toBe('28.4'); // grounded value, not invented
  });

  it('does NOT double an AHI the model already surfaced, but still backfills the missing RDI', () => {
    const model = coerceMeasurements([{ label: 'AHI', value: '28.4', unit: 'events/hr', qualifier: 'diagnostic' }], PSG_CTX);
    const out = ensureSeverityMeasurements(model, PSG_CTX);
    expect(out.filter((m) => m.label === 'AHI')).toHaveLength(1); // no duplicate AHI
    expect(out.some((m) => m.label === 'RDI')).toBe(true);        // RDI backfilled
  });

  it('non-sleep case is unchanged — no invented AHI (no regression for BP/A1c charts)', () => {
    const ctx = 'Claimed condition: Hypertension\nVitals 5/2024: blood pressure 142/88 mmHg, heart rate 72.';
    const model = coerceMeasurements([{ label: 'Blood pressure', value: '142/88', unit: 'mmHg' }], ctx);
    const out = ensureSeverityMeasurements(model, ctx);
    expect(out).toEqual(model);
    expect(out.some((m) => /ahi|rdi/i.test(m.label))).toBe(false);
  });

  it('sleep-study-present-but-AHI-absent → does NOT invent AHI, keeps the model output', () => {
    const ctx = [
      'Claimed condition: Obstructive sleep apnea',
      '[Sleep p1] Sleep study ordered; polysomnogram pending. Loud snoring and witnessed apneas reported.',
      '[Clinic] BMI 41 kg/m2.',
    ].join('\n');
    const model = coerceMeasurements([{ label: 'BMI', value: '41', unit: 'kg/m2' }], ctx);
    const out = ensureSeverityMeasurements(model, ctx);
    expect(out.map((m) => m.label)).toEqual(['BMI']);
    expect(out.some((m) => m.label === 'AHI')).toBe(false);
  });
});

// ── DIGEST TRUNCATION FIX (root cause of the Foster collapse-to-BMI) ──
// documentDigest emits VERBATIM high-signal page spans; on a large COMPLETE chart the polysomnogram span can sit
// PAST the 12k CHART_DIGEST_CAP, so the OLD naive head-slice dropped the AHI line before the model ever saw it →
// the model could only surface the early-appearing BMI. boundChartDigest floats the verbatim key study lines to
// the front of the capped context so AHI/RDI survive the truncation.
describe('renderContext digest bounding — PSG numbers survive the 12k cap', () => {
  it('keeps AHI/RDI even when their line sits far past the cap in a large chart', () => {
    const filler = Array.from({ length: 400 }, (_, i) =>
      `[filler doc p${i}] routine progress note, vitals stable, no acute distress, continue current plan.`).join('\n');
    const bigDigest = `${filler}\n[Sleep p3] Polysomnogram 4/2024: AHI 28.4 events/hr (diagnostic); RDI 33.1 events/hr; lowest SpO2 81%.`;
    // Precondition: the digest exceeds the cap AND the AHI line is buried past it (the old head-slice would drop it).
    expect(bigDigest.length).toBeGreaterThan(12_000);
    expect(bigDigest.indexOf('AHI 28.4')).toBeGreaterThan(12_000);

    const rendered = __renderContextForTest({ claimedCondition: 'Obstructive sleep apnea', chartDigest: bigDigest });
    expect(rendered).toContain('AHI 28.4');
    expect(rendered).toContain('RDI 33.1');
    // And because the numbers are now IN the context, the backstop can ground+surface them.
    const ms = extractSeverityMeasurementsFromContext(rendered);
    expect(ms.map((m) => m.label).sort()).toEqual(['AHI', 'RDI']);
  });

  it('leaves a small digest untouched (no bounding when it fits)', () => {
    const small = '[Sleep p1] Polysomnogram: AHI 12.3 events/hr.';
    const rendered = __renderContextForTest({ claimedCondition: 'Obstructive sleep apnea', chartDigest: small });
    expect(rendered).toContain(small);
    expect(rendered).not.toContain('Key study measurements found in the records:');
  });
});
