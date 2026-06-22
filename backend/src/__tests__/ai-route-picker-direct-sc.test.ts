// DIRECT-SC PROMPT CONTRACT (Ryan 2026-06-22, Zimmelman). The route-picker applied SECONDARY-claim logic
// ("must have an SC anchor") to Zimmelman's GERD, which has IN-SERVICE STR documentation → a DIRECT route
// that needs NO anchor. The vendored picker brain must now make the direct-vs-secondary distinction explicit:
// it must check in-service onset/diagnosis BEFORE concluding "no anchor → not supportable", and the mere
// absence of an SC anchor must NOT drive a not_supportable verdict. These pin that prompt CONTRACT on the
// vendored copy (a $0 string check — no LLM call), so a re-vendor that drops the direct-route doctrine reds
// the build. Behavior on the real case is verified separately against RDS.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const picker = req('../vendor/aiRoutePicker.cjs') as {
  SYSTEM: string;
  TOOL: { name: string; input_schema: { properties: { primary_anchor: { properties: { framing: { enum: string[] }; cfr_basis: { enum: string[] } } } } } };
};

describe('vendored aiRoutePicker — DIRECT-SC contract (Zimmelman)', () => {
  it('the SYSTEM prompt forces a DIRECT-ROUTE FIRST CHECK before falling to "no anchor"', () => {
    expect(picker.SYSTEM).toMatch(/DIRECT-ROUTE FIRST CHECK/);
    // It must say a direct route needs NO service-connected anchor.
    expect(picker.SYSTEM).toMatch(/needs NO service-connected ["“]?anchor|requires NO service-connected anchor|needs NO .*anchor/i);
    // It must treat an in-service diagnosis/STR onset as a direct trigger.
    expect(picker.SYSTEM).toMatch(/in-service (STR )?diagnosis|in-service onset|shown in service|documented DURING active service/i);
  });

  it('the SYSTEM prompt forbids returning not_supportable merely for lack of an SC anchor', () => {
    expect(picker.SYSTEM).toMatch(/NOT, by itself, a reason to return not_supportable|"there is no granted SC anchor" is NOT/i);
  });

  it('the tool still supports a DIRECT framing + 3.303 basis (the direct route is emittable)', () => {
    const framingEnum = picker.TOOL.input_schema.properties.primary_anchor.properties.framing.enum;
    const cfrEnum = picker.TOOL.input_schema.properties.primary_anchor.properties.cfr_basis.enum;
    expect(framingEnum).toContain('direct');
    expect(cfrEnum).toContain('3.303');
  });
});
