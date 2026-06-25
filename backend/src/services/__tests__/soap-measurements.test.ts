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
import { coerceMeasurements, withMeasurementsInObjective } from '../soap-overview.js';

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
