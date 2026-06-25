import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// SINGLE-SOURCE GUARD (Ryan 2026-06-19): backend/src/vendor/aiRoutePicker.cjs is the VENDORED copy of the
// canonical flatratenexus-project/app/services/aiRoutePicker.js (the picker brain the drafter uses). The
// EMR viability card (ai-viability.ts) loads SYSTEM+TOOL from it so the card + drafter cannot drift. This
// pin trips the red build on ANY hand-edit or stale re-vendor — re-sync from the FRN canonical, then
// update PINNED_AIROUTEPICKER_SHA256 in the SAME commit (mirrors anchor-table-pin.test.ts).
const PINNED_AIROUTEPICKER_SHA256 = '1527fb416fb5a894d345e6fef8b78f4b03593d3ee30629f992aebc1e8afeb93d';

describe('aiRoutePicker.cjs vendored prompt pin', () => {
  it('vendored aiRoutePicker.cjs sha256 === pin (catches drift from the FRN canonical)', () => {
    const sha = createHash('sha256').update(readFileSync(new URL('../vendor/aiRoutePicker.cjs', import.meta.url))).digest('hex');
    expect(sha).toBe(PINNED_AIROUTEPICKER_SHA256);
  });
  it('vendored module exports a usable SYSTEM + forced TOOL', () => {
    const req = createRequire(import.meta.url);
    const m = req('../vendor/aiRoutePicker.cjs') as { SYSTEM?: string; TOOL?: { name?: string; input_schema?: { required?: string[] } } };
    expect(typeof m.SYSTEM).toBe('string');
    expect((m.SYSTEM ?? '').length).toBeGreaterThan(2000);
    expect(m.TOOL?.name).toBe('emit_argument_plan');
    expect(m.TOOL?.input_schema?.required).toContain('excluded_anchors');
  });
});
