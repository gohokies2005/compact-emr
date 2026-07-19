import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  validateSchema,
  gradeRank,
  GATED_FILESET,
  ENFORCER_GATE_MAJOR,
  STALENESS_BACKSTOP_MS,
} from '../preflight-drafter-gate.js';

// ---------------------------------------------------------------------------
// Fixtures: a fully-valid artifact + observed env that MUST pass (GREEN baseline).
// Each rule test mutates exactly one thing and asserts the matching BLOCK fires (RED).
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-05-29T22:00:00Z');
const GATED_SHA = 'abc123def4567890abc123def4567890abc12345';

function basePass() {
  const artifact = {
    gate_version: '1.0',
    produced_at: '2026-05-29T21:00:00Z',
    gated_sha: GATED_SHA,
    pipeline_fileset_hash: 'deadbeefcafe',
    tier_a: { status: 'pass', is_quality_gate: false, checks: [{ id: 'x', status: 'pass' }] },
    tier_b: {
      status: 'pass',
      real_panel: true,
      fixture: 'TestVet-Lumbar',
      fixture_schema_version: 3,
      grade: 'B+',
      grade_floor: 'B',
      cost_usd_estimate: 10,
    },
    overall: 'pass',
  };
  const observed = {
    artifactPresent: true,
    recomputedFilesetHash: 'deadbeefcafe', // matches artifact
    recomputedPerFile: null,
    gatedShaIsAncestorOfDeploy: true,
    deployImageTag: `${GATED_SHA}-drafter15`, // contains gated_sha
    ecrDigest: null,
    workingTreeClean: true,
    detachedHead: false,
    committerDateMs: NOW - 3600_000,
    nowMs: NOW,
  };
  const config = {
    gateMajor: 1,
    stalenessMs: STALENESS_BACKSTOP_MS,
    expectedFixtureSchemaVersion: 3,
  };
  return { artifact, observed, config };
}

/** Run evaluateGate and return the block tags ([R4], [H2], ...) for assertion. */
function blockTags(artifact, observed, config) {
  const r = evaluateGate(artifact, observed, config);
  return { ok: r.ok, tags: r.blocks.map((b) => b.match(/^\[([^\]]+)\]/)?.[1]), blocks: r.blocks, warnings: r.warnings };
}

describe('GREEN baseline', () => {
  it('a complete, fresh, matching real-panel PASS is allowed (ok:true)', () => {
    const { artifact, observed, config } = basePass();
    const r = evaluateGate(artifact, observed, config);
    expect(r.ok).toBe(true);
    expect(r.blocks).toEqual([]);
  });

  it('baseline carries the I0 mutable-tag warning (no image_ref digest present)', () => {
    const { artifact, observed, config } = basePass();
    const r = evaluateGate(artifact, observed, config);
    expect(r.warnings.join(' ')).toMatch(/I0/);
  });
});

describe('RED — every BLOCK rule fires on its own trigger', () => {
  it('R1: artifact absent', () => {
    const { observed, config } = basePass();
    const r = blockTags(null, { ...observed, artifactPresent: false }, config);
    expect(r.ok).toBe(false);
    expect(r.tags).toContain('R1');
  });

  it('SCHEMA: missing required field hard-blocks before rules run', () => {
    const { artifact, observed, config } = basePass();
    delete artifact.overall;
    const r = blockTags(artifact, observed, config);
    expect(r.ok).toBe(false);
    expect(r.tags).toContain('SCHEMA');
  });

  it('SCHEMA: malformed produced_at blocks (never silently skips staleness)', () => {
    const { artifact, observed, config } = basePass();
    artifact.produced_at = 'not-a-date';
    const r = blockTags(artifact, observed, config);
    expect(r.ok).toBe(false);
    expect(r.tags).toContain('SCHEMA');
  });

  it('SCHEMA: is_quality_gate true is rejected', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_a.is_quality_gate = true;
    const r = blockTags(artifact, observed, config);
    expect(r.ok).toBe(false);
    expect(r.tags).toContain('SCHEMA');
  });

  it('H1: gate_version major mismatch', () => {
    const { artifact, observed, config } = basePass();
    artifact.gate_version = '2.0';
    const r = blockTags(artifact, observed, config);
    expect(r.ok).toBe(false);
    expect(r.tags).toContain('H1');
  });

  it('R2: overall != pass', () => {
    const { artifact, observed, config } = basePass();
    artifact.overall = 'fail';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('R2');
  });

  it('R2: overall typo "passs" blocks (affirmative whitelist)', () => {
    const { artifact, observed, config } = basePass();
    artifact.overall = 'passs';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('R2');
  });

  it('H4: tier_a.status != pass', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_a.status = 'fail';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H4');
  });

  it('R3: tier_b.status skipped', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.status = 'skipped';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('R3');
  });

  it('R3: tier_b.real_panel false (stubbed grade)', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.real_panel = false;
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('R3');
  });

  it('H7: real_panel true but cost <= 0 (stub mislabeled real)', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.cost_usd_estimate = 0;
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H7');
  });

  it('H2: grade below floor', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.grade = 'C';
    artifact.tier_b.grade_floor = 'B';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H2');
  });

  it('H2: unknown grade string fails closed', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.grade = 'totally-bogus';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H2');
  });

  it('H3: fixture_schema_version != expected (stale fixture)', () => {
    const { artifact, observed, config } = basePass();
    artifact.tier_b.fixture_schema_version = 2;
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H3');
  });

  it('R4: single-hash mismatch (a gated file changed)', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, recomputedFilesetHash: 'changedhash' }, config);
    expect(r.tags).toContain('R4');
  });

  it('R4: per-file array path catches a single changed file', () => {
    const { artifact, observed, config } = basePass();
    artifact.pipeline_fileset = [
      { path: 'app/services/claude.js', sha256: 'aaa' },
      { path: 'app/services/coverMemo.js', sha256: 'bbb' },
    ];
    delete artifact.pipeline_fileset_hash;
    const recomputedPerFile = [
      { path: 'app/services/claude.js', sha256: 'aaa' },
      { path: 'app/services/coverMemo.js', sha256: 'CHANGED' },
    ];
    const r = blockTags(artifact, { ...observed, recomputedPerFile, recomputedFilesetHash: null }, config);
    expect(r.tags).toContain('R4');
    expect(r.blocks.join(' ')).toMatch(/coverMemo\.js/);
  });

  it('R4: per-file array passes when every file matches', () => {
    const { artifact, observed, config } = basePass();
    const files = [
      { path: 'app/services/claude.js', sha256: 'aaa' },
      { path: 'app/services/coverMemo.js', sha256: 'bbb' },
    ];
    artifact.pipeline_fileset = files;
    delete artifact.pipeline_fileset_hash;
    const r = evaluateGate(artifact, { ...observed, recomputedPerFile: files.map((f) => ({ ...f })), recomputedFilesetHash: null }, config);
    expect(r.ok).toBe(true);
  });

  it('R4: extra un-gated file in deploy checkout blocks', () => {
    const { artifact, observed, config } = basePass();
    artifact.pipeline_fileset = [{ path: 'app/services/claude.js', sha256: 'aaa' }];
    delete artifact.pipeline_fileset_hash;
    const recomputedPerFile = [
      { path: 'app/services/claude.js', sha256: 'aaa' },
      { path: 'app/services/sneaky.js', sha256: 'zzz' },
    ];
    const r = blockTags(artifact, { ...observed, recomputedPerFile, recomputedFilesetHash: null }, config);
    expect(r.tags).toContain('R4');
  });

  it('R4: no comparable hash available blocks', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, recomputedFilesetHash: null, recomputedPerFile: null }, config);
    expect(r.tags).toContain('R4');
  });

  it('R5: gated_sha not ancestor of deploy SHA', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, gatedShaIsAncestorOfDeploy: false }, config);
    expect(r.tags).toContain('R5');
  });

  it('H5: dirty working tree in FRN checkout', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, workingTreeClean: false }, config);
    expect(r.tags).toContain('H5');
  });

  it('H6: detached HEAD', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, detachedHead: true }, config);
    expect(r.tags).toContain('H6');
  });

  it('R6: stale (> 7d old)', () => {
    const { artifact, observed, config } = basePass();
    artifact.produced_at = new Date(NOW - 8 * 86400_000).toISOString();
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('R6');
  });

  it('H8: produced_at absurdly in the future', () => {
    const { artifact, observed, config } = basePass();
    artifact.produced_at = new Date(NOW + 5 * 86400_000).toISOString();
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('H8');
  });

  it('H8: produced_at predates committer date of gated_sha', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, committerDateMs: NOW }, config); // produced 21:00 < commit 22:00
    expect(r.tags).toContain('H8');
  });

  it('I0: deploy image tag does not contain gated_sha', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, deployImageTag: 'some-other-image-tag' }, config);
    expect(r.tags).toContain('I0');
  });

  it('I0: image tag unresolved blocks', () => {
    const { artifact, observed, config } = basePass();
    const r = blockTags(artifact, { ...observed, deployImageTag: null }, config);
    expect(r.tags).toContain('I0');
  });

  it('I1: image_ref present but is a mutable tag (no @sha256)', () => {
    const { artifact, observed, config } = basePass();
    artifact.image_ref = '676591241787.dkr.ecr.us-east-1.amazonaws.com/drafter:latest';
    const r = blockTags(artifact, observed, config);
    expect(r.tags).toContain('I1');
  });

  it('I1: image_ref digest does not match ECR-resolved digest', () => {
    const { artifact, observed, config } = basePass();
    artifact.image_ref = '676591241787.dkr.ecr.us-east-1.amazonaws.com/drafter@sha256:aaaa';
    const r = blockTags(artifact, { ...observed, ecrDigest: 'sha256:bbbb' }, config);
    expect(r.tags).toContain('I1');
  });

  it('I1: image_ref digest matches ECR digest -> passes (and no I0 warning)', () => {
    const { artifact, observed, config } = basePass();
    artifact.image_ref = '676591241787.dkr.ecr.us-east-1.amazonaws.com/drafter@sha256:aaaa';
    const r = evaluateGate(artifact, { ...observed, ecrDigest: 'sha256:aaaa' }, config);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).not.toMatch(/I0/);
  });
});

describe('multiple simultaneous failures all surface', () => {
  it('collects every independent block reason', () => {
    const { artifact, observed, config } = basePass();
    artifact.overall = 'fail';
    artifact.tier_b.real_panel = false;
    const r = blockTags(artifact, { ...observed, workingTreeClean: false }, config);
    expect(r.tags).toEqual(expect.arrayContaining(['R2', 'R3', 'H5']));
  });
});

describe('unit: helpers', () => {
  it('gradeRank orders A+ best, below-floor detectable', () => {
    expect(gradeRank('A+')).toBeLessThan(gradeRank('B'));
    expect(gradeRank('C')).toBeGreaterThan(gradeRank('B'));
    expect(gradeRank('nonsense')).toBe(Number.POSITIVE_INFINITY);
  });

  it('validateSchema accepts a well-formed artifact', () => {
    const { artifact } = basePass();
    expect(validateSchema(artifact)).toEqual([]);
  });

  it('GATED_FILESET is the producer-synced v1.1 set (36, 2026-07-16 sync) in order', () => {
    expect(GATED_FILESET).toHaveLength(36);
    expect(GATED_FILESET[0]).toBe('app/scripts/run-letter-pipeline.js');
    // The 3 modules the 2026-07-16 sync added (33→36, R4 drift fix) at canonical positions:
    expect(GATED_FILESET[8]).toBe('app/services/transientRetry.js');       // after framingGate.js
    expect(GATED_FILESET[17]).toBe('app/services/citationFallback.js');    // after citationAuditor.js
    expect(GATED_FILESET[31]).toBe('app/services/planValidityGate.js');    // after pipelineCheck.js
    // Original-10 tail + surrounding anchors, shifted by the transientRetry insertion:
    expect(GATED_FILESET[10]).toBe('app/services/routingResolver.js');     // last of the original 10
    // The 4 promotions the 2026-06-11 sync added (R4 drift fix):
    expect(GATED_FILESET[19]).toBe('app/services/conditionCanon.js');
    expect(GATED_FILESET[24]).toBe('app/services/draftingGuidance.js');
    expect(GATED_FILESET[26]).toBe('app/services/forbiddenWordPass.js');
    expect(GATED_FILESET[29]).toBe('app/services/opinionSentence.js');
    // The 4 promotions the 2026-06-22 cutover (52297d4) added (route-picker/checkpoint/body-quality/fold):
    expect(GATED_FILESET[12]).toBe('app/services/aiRoutePicker.js');        // after aggravationTriggers.js
    expect(GATED_FILESET[15]).toBe('app/services/checkpointManifest.js');   // after cavcRegistry.js
    expect(GATED_FILESET[23]).toBe('app/services/draftBodyQualityGate.js'); // after deprecatedPhrases.js
    expect(GATED_FILESET[25]).toBe('app/services/foldRenderable.js');       // after draftingGuidance.js
    expect(GATED_FILESET[35]).toBe('references/medical_literature/curated/routing.json'); // data file LAST
  });

  it('ENFORCER_GATE_MAJOR is 1', () => {
    expect(ENFORCER_GATE_MAJOR).toBe(1);
  });
});
