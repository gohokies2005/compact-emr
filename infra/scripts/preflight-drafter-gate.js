#!/usr/bin/env node
/**
 * C0 deploy-gate ENFORCER — blocks `cdk deploy` of the FRN cloud drafter unless the
 * committed gate artifact is a valid / fresh / matching real-panel PASS.
 *
 * Contract: shared/outbox/2026-05-29_C0_deploy_gate_contract_v1.0_LOCKED.md (FRN repo).
 * Amendment requested (v1.1): shared/inbox/2026-05-29_C0_deploy_gate_AMENDMENT_REQUEST_v1.1.md
 *   - image_ref (immutable ECR digest) binding
 *   - pipeline_fileset[] per-file hashes
 * This enforcer is SCHEMA-TOLERANT: runs on v1.0 (single hash, interim tag-contains-sha image
 * binding + loud warning) AND on v1.1 (per-file array + ECR digest rule), preferring v1.1.
 *
 * Design: pure rule logic (`evaluateGate`) is separated from IO (`gatherObserved`/`main`) so the
 * full BLOCK matrix is unit-testable with synthetic artifacts + a synthetic observed-environment,
 * with no real FRN checkout / git / AWS required.
 *
 * Fail-closed: ANY block reason → non-zero exit → deploy chain stops. A gate that PASSES when it
 * should BLOCK is the single worst outcome this gate exists to prevent.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Enforcer understands this contract major. Artifact gate_version major must match. */
export const ENFORCER_GATE_MAJOR = 1;

/** Staleness backstop (contract: hash equality is the real gate; this is "something's weird"). */
export const STALENESS_BACKSTOP_MS = 7 * 24 * 60 * 60 * 1000;

/** Tolerance for "produced_at absurdly in the future" (clock skew). */
export const FUTURE_SKEW_MS = 60 * 60 * 1000; // 1h

/**
 * Gated fileset — FINAL per locked contract v1.0 §Redline-1. Order is load-bearing for the
 * single-hash path: code modules first (in this order), then runtime-read data files.
 */
export const GATED_FILESET = [
  'app/scripts/run-letter-pipeline.js',
  'app/scripts/drafter-worker.js',
  'app/services/pipelinePhase.js',
  'app/services/pipelineLinter.js',
  'app/services/claude.js',
  'app/services/coverMemo.js',
  'app/services/autoPatch.js',
  'app/services/framingGate.js',
  'app/services/templatePicker.js',
  'app/services/routingResolver.js',
  'references/medical_literature/curated/routing.json',
];

/** Probative grade order, best → worst. Index = rank (lower is better). */
export const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];

export function gradeRank(g) {
  if (typeof g !== 'string') return Number.POSITIVE_INFINITY;
  const i = GRADE_ORDER.indexOf(g.trim());
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

// ---------------------------------------------------------------------------
// Hashing helpers (pure given file bytes)
// ---------------------------------------------------------------------------

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Single concatenated hash over the fileset, in GATED_FILESET order. v1.0 path. */
export function computeFilesetHash(frnDir, fileset = GATED_FILESET) {
  const h = createHash('sha256');
  for (const rel of fileset) {
    h.update(readFileSync(join(frnDir, rel)));
  }
  return h.digest('hex');
}

/** Per-file hashes. v1.1 path — preferred (concat-order/newline/encoding drift impossible). */
export function computePerFileHashes(frnDir, fileset = GATED_FILESET) {
  return fileset.map((rel) => ({
    path: rel,
    sha256: sha256Hex(readFileSync(join(frnDir, rel))),
  }));
}

// ---------------------------------------------------------------------------
// Schema validation (fail-closed, BEFORE rule evaluation)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate the artifact shape. Returns array of violation strings (empty = valid).
 * A malformed field (e.g. unparseable produced_at) must BLOCK, never silently skip a rule.
 */
export function validateSchema(a) {
  const v = [];
  if (!isPlainObject(a)) return ['artifact is not a JSON object'];

  const reqStr = ['gate_version', 'produced_at', 'gated_sha', 'overall'];
  for (const k of reqStr) {
    if (typeof a[k] !== 'string' || a[k].length === 0) v.push(`missing/!string: ${k}`);
  }

  // Fileset proof: at least one of the two representations must be present + well-typed.
  const hasHash = typeof a.pipeline_fileset_hash === 'string' && a.pipeline_fileset_hash.length > 0;
  const hasArr = Array.isArray(a.pipeline_fileset) && a.pipeline_fileset.length > 0;
  if (!hasHash && !hasArr) {
    v.push('missing fileset proof: need pipeline_fileset_hash (string) or pipeline_fileset (array)');
  }
  if (hasArr) {
    a.pipeline_fileset.forEach((e, i) => {
      if (!isPlainObject(e) || typeof e.path !== 'string' || typeof e.sha256 !== 'string') {
        v.push(`pipeline_fileset[${i}] malformed (need {path,sha256})`);
      }
    });
  }

  if (typeof a.produced_at === 'string' && Number.isNaN(Date.parse(a.produced_at))) {
    v.push('produced_at is not a parseable date');
  }

  if (!isPlainObject(a.tier_a)) {
    v.push('tier_a missing/!object');
  } else {
    if (typeof a.tier_a.status !== 'string') v.push('tier_a.status !string');
    if (a.tier_a.is_quality_gate !== false) v.push('tier_a.is_quality_gate must be false');
    if (!Array.isArray(a.tier_a.checks)) v.push('tier_a.checks !array');
  }

  if (!isPlainObject(a.tier_b)) {
    v.push('tier_b missing/!object');
  } else {
    if (typeof a.tier_b.status !== 'string') v.push('tier_b.status !string');
    if (typeof a.tier_b.real_panel !== 'boolean') v.push('tier_b.real_panel !boolean');
    if (typeof a.tier_b.fixture !== 'string') v.push('tier_b.fixture !string');
    if (!Number.isInteger(a.tier_b.fixture_schema_version)) v.push('tier_b.fixture_schema_version !int');
    if (typeof a.tier_b.grade !== 'string') v.push('tier_b.grade !string');
    if (typeof a.tier_b.grade_floor !== 'string') v.push('tier_b.grade_floor !string');
    if (typeof a.tier_b.cost_usd_estimate !== 'number') v.push('tier_b.cost_usd_estimate !number');
  }

  // image_ref optional (v1.1). If present it must be a string.
  if ('image_ref' in a && typeof a.image_ref !== 'string') v.push('image_ref present but !string');

  return v;
}

// ---------------------------------------------------------------------------
// Pure rule evaluation
// ---------------------------------------------------------------------------

/**
 * @param {object|null} artifact  parsed _gate/drafter_deploy_gate.json (null = absent)
 * @param {object} observed environment facts gathered by IO:
 *   {
 *     artifactPresent: boolean,
 *     recomputedFilesetHash: string|null,        // v1.0 path
 *     recomputedPerFile: [{path,sha256}]|null,    // v1.1 path
 *     gatedShaIsAncestorOfDeploy: boolean|null,   // git merge-base --is-ancestor
 *     deployImageTag: string|null,                // tag the deploy will ship
 *     ecrDigest: string|null,                     // digest resolved/confirmed in ECR (v1.1)
 *     workingTreeClean: boolean|null,             // FRN checkout `git status --porcelain` empty
 *     detachedHead: boolean|null,
 *     committerDateMs: number|null,               // committer date of gated_sha
 *     nowMs: number,
 *   }
 * @param {object} config { gateMajor, stalenessMs, expectedFixtureSchemaVersion? }
 * @returns {{ ok: boolean, blocks: string[], warnings: string[] }}
 */
export function evaluateGate(artifact, observed, config = {}) {
  const blocks = [];
  const warnings = [];
  const gateMajor = config.gateMajor ?? ENFORCER_GATE_MAJOR;
  const stalenessMs = config.stalenessMs ?? STALENESS_BACKSTOP_MS;
  const now = observed.nowMs ?? Date.now();

  const block = (rule, reason) => blocks.push(`[${rule}] ${reason}`);

  // R1 — artifact absent (never-ran and deleted are indistinguishable; both hard-block).
  if (!observed.artifactPresent || artifact == null) {
    block('R1', 'gate artifact absent — no _gate/drafter_deploy_gate.json');
    return { ok: false, blocks, warnings };
  }

  // Schema validation FIRST — fail-closed before any rule can silently skip on a malformed field.
  const schemaViolations = validateSchema(artifact);
  if (schemaViolations.length) {
    for (const sv of schemaViolations) block('SCHEMA', sv);
    return { ok: false, blocks, warnings };
  }

  // H1 — gate_version major must match enforcer (a v2 artifact read by v1 enforcer = silent misread).
  const major = parseInt(String(artifact.gate_version).split('.')[0], 10);
  if (!Number.isInteger(major) || major !== gateMajor) {
    block('H1', `gate_version major ${artifact.gate_version} != enforcer major ${gateMajor}`);
  }

  // R2 — overall must affirmatively equal "pass" (typo'd/unknown status blocks).
  if (artifact.overall !== 'pass') {
    block('R2', `overall != "pass" (got "${artifact.overall}")`);
  }

  // H4 — tier_a must affirmatively pass and never masquerade as a quality gate.
  if (artifact.tier_a.status !== 'pass') {
    block('H4', `tier_a.status != "pass" (got "${artifact.tier_a.status}")`);
  }
  if (artifact.tier_a.is_quality_gate !== false) {
    block('H4', 'tier_a.is_quality_gate must be false');
  }

  // R3 — Tier B real-panel grade is mandatory every deploy (the anti-"gate that lies" guarantee).
  if (artifact.tier_b.status !== 'pass') {
    block('R3', `tier_b.status != "pass" (got "${artifact.tier_b.status}")`);
  }
  if (artifact.tier_b.real_panel !== true) {
    block('R3', 'tier_b.real_panel != true — grade not from a real LLM panel');
  }

  // H7 — cost tripwire: a real panel costs money; <=0 means a stubbed panel mislabeled real.
  if (artifact.tier_b.real_panel === true && !(artifact.tier_b.cost_usd_estimate > 0)) {
    block('H7', `real_panel:true but cost_usd_estimate=${artifact.tier_b.cost_usd_estimate} (<=0)`);
  }

  // H2 — grade must be at or above floor (real_panel proves the panel RAN, not that it PASSED).
  const gRank = gradeRank(artifact.tier_b.grade);
  const fRank = gradeRank(artifact.tier_b.grade_floor);
  if (!Number.isFinite(gRank)) {
    block('H2', `tier_b.grade "${artifact.tier_b.grade}" not in known grade order`);
  } else if (!Number.isFinite(fRank)) {
    block('H2', `tier_b.grade_floor "${artifact.tier_b.grade_floor}" not in known grade order`);
  } else if (gRank > fRank) {
    block('H2', `grade ${artifact.tier_b.grade} below floor ${artifact.tier_b.grade_floor}`);
  }

  // H3 — fixture_schema_version must match enforcer expectation when pinned (stale fixture guard).
  if (config.expectedFixtureSchemaVersion != null) {
    if (artifact.tier_b.fixture_schema_version !== config.expectedFixtureSchemaVersion) {
      block('H3', `fixture_schema_version ${artifact.tier_b.fixture_schema_version} != expected ${config.expectedFixtureSchemaVersion}`);
    }
  } else {
    warnings.push('H3: no expectedFixtureSchemaVersion pinned — fixture staleness unchecked');
  }

  // R4 — fileset hash must match what we're deploying. Prefer per-file (drift-proof).
  if (Array.isArray(artifact.pipeline_fileset) && observed.recomputedPerFile) {
    const byPath = new Map(observed.recomputedPerFile.map((e) => [e.path, e.sha256]));
    for (const e of artifact.pipeline_fileset) {
      const local = byPath.get(e.path);
      if (local == null) {
        block('R4', `fileset path not found in deploy checkout: ${e.path}`);
      } else if (local !== e.sha256) {
        block('R4', `fileset file changed since gate: ${e.path}`);
      }
    }
    // catch a deploy checkout that has an EXTRA gated file the artifact didn't cover
    const artifactPaths = new Set(artifact.pipeline_fileset.map((e) => e.path));
    for (const e of observed.recomputedPerFile) {
      if (!artifactPaths.has(e.path)) block('R4', `deploy checkout has un-gated fileset file: ${e.path}`);
    }
  } else if (typeof artifact.pipeline_fileset_hash === 'string' && observed.recomputedFilesetHash) {
    if (artifact.pipeline_fileset_hash !== observed.recomputedFilesetHash) {
      block('R4', 'pipeline_fileset_hash mismatch — a gated file changed since the gate ran');
    }
  } else {
    block('R4', 'cannot verify fileset — no comparable hash/per-file pair available');
  }

  // R5 — gated_sha must be ancestor-of-or-equal to the deploy SHA.
  if (observed.gatedShaIsAncestorOfDeploy !== true) {
    block('R5', 'gated_sha is not an ancestor of (or equal to) the deploy SHA');
  }
  // H5/H6 — the FRN image-build checkout must be clean + not detached (else "deploy SHA" is a lie).
  if (observed.workingTreeClean !== true) {
    block('H5', 'FRN image-build checkout has uncommitted changes (git status --porcelain non-empty)');
  }
  if (observed.detachedHead === true) {
    block('H6', 'FRN image-build checkout is in detached-HEAD — ambiguous deploy SHA');
  }

  // R6 — staleness backstop.
  const producedMs = Date.parse(artifact.produced_at);
  if (now - producedMs > stalenessMs) {
    block('R6', `gate artifact is stale (> ${Math.round(stalenessMs / 86400000)}d old)`);
  }
  // H8 — clock cross-checks: not before the commit it claims to gate, not absurdly future.
  if (producedMs > now + FUTURE_SKEW_MS) {
    block('H8', 'produced_at is in the future beyond clock skew — forged/replayed artifact');
  }
  if (observed.committerDateMs != null && producedMs < observed.committerDateMs) {
    block('H8', 'produced_at predates the committer date of gated_sha — artifact cannot be valid');
  }

  // Image binding.
  if (typeof artifact.image_ref === 'string' && artifact.image_ref.length) {
    // v1.1 — immutable digest binding.
    if (!artifact.image_ref.includes('@sha256:')) {
      block('I1', `image_ref must be an immutable digest (@sha256:...), got "${artifact.image_ref}"`);
    } else if (observed.ecrDigest == null) {
      block('I1', 'image_ref digest could not be confirmed present in ECR');
    } else {
      const wantDigest = artifact.image_ref.split('@')[1];
      if (wantDigest !== observed.ecrDigest) {
        block('I1', `deploy image digest ${observed.ecrDigest} != gated image_ref ${wantDigest}`);
      }
    }
  } else {
    // v1.0 interim — tag-contains-gated_sha. Mutable; loud warning.
    warnings.push('I0: no image_ref digest in artifact — falling back to MUTABLE tag binding (request v1.1 amendment)');
    const tag = observed.deployImageTag;
    const sha = String(artifact.gated_sha);
    const shaShort = sha.slice(0, 7);
    if (!tag) {
      block('I0', 'could not resolve the deploy image tag to bind against gated_sha');
    } else if (!(tag.includes(sha) || tag.includes(shaShort))) {
      block('I0', `deploy image tag "${tag}" does not contain gated_sha ${shaShort} — unverified image`);
    }
  }

  return { ok: blocks.length === 0, blocks, warnings };
}

// ---------------------------------------------------------------------------
// IO gathering (not unit-tested; smoke-tested via real invocation)
// ---------------------------------------------------------------------------

function git(frnDir, args) {
  return execFileSync('git', ['-C', frnDir, ...args], { encoding: 'utf8' }).trim();
}

function gatherObserved(opts) {
  const { frnDir, artifactPath, deploySha, deployImageTag } = opts;
  const observed = {
    artifactPresent: existsSync(artifactPath),
    recomputedFilesetHash: null,
    recomputedPerFile: null,
    gatedShaIsAncestorOfDeploy: null,
    deployImageTag: deployImageTag ?? null,
    ecrDigest: null,
    workingTreeClean: null,
    detachedHead: null,
    committerDateMs: null,
    nowMs: Date.now(),
  };
  if (!observed.artifactPresent) return observed;

  // Hash recompute (both representations; evaluateGate picks the right one per artifact shape).
  try {
    observed.recomputedFilesetHash = computeFilesetHash(frnDir);
    observed.recomputedPerFile = computePerFileHashes(frnDir);
  } catch (e) {
    // A missing gated file in the deploy checkout is itself a block-worthy condition; surface it.
    observed.recomputedFilesetHash = null;
    observed.recomputedPerFile = null;
    observed._hashError = String(e && e.message ? e.message : e);
  }

  // git facts about the FRN image-build checkout.
  try {
    observed.workingTreeClean = git(frnDir, ['status', '--porcelain']).length === 0;
    const head = git(frnDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    observed.detachedHead = head === 'HEAD';
  } catch (e) {
    observed._gitError = String(e && e.message ? e.message : e);
  }

  return observed;
}

function loadArtifact(artifactPath) {
  if (!existsSync(artifactPath)) return null;
  try {
    return JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    // Unparseable artifact → treat as malformed; schema validation will hard-block.
    return { __unparseable__: true };
  }
}

function resolveAncestry(frnDir, gatedSha, deploySha, observed) {
  if (!gatedSha || !deploySha) return;
  try {
    execFileSync('git', ['-C', frnDir, 'merge-base', '--is-ancestor', gatedSha, deploySha], { stdio: 'ignore' });
    observed.gatedShaIsAncestorOfDeploy = true;
  } catch {
    // non-zero exit = not an ancestor (or unknown sha)
    observed.gatedShaIsAncestorOfDeploy = gatedSha === deploySha;
  }
  try {
    const iso = execFileSync('git', ['-C', frnDir, 'show', '-s', '--format=%cI', gatedSha], { encoding: 'utf8' }).trim();
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) observed.committerDateMs = ms;
  } catch { /* committer date best-effort */ }
}

function printReport(result, ctx) {
  const line = '─'.repeat(67);
  process.stderr.write(`\n${line}\n  C0 DEPLOY-GATE ENFORCER — preflight-drafter-gate\n${line}\n`);
  process.stderr.write(`  artifact : ${ctx.artifactPath}\n`);
  process.stderr.write(`  FRN dir  : ${ctx.frnDir}\n`);
  process.stderr.write(`  deploySHA: ${ctx.deploySha ?? '(unset)'}\n`);
  process.stderr.write(`  imageTag : ${ctx.deployImageTag ?? '(unset)'}\n`);
  for (const w of result.warnings) process.stderr.write(`  ⚠ WARN  ${w}\n`);
  if (result.ok) {
    process.stderr.write(`\n  ✅ PASS — gate valid for this deploy. ${result.warnings.length} warning(s).\n${line}\n`);
  } else {
    process.stderr.write(`\n  ⛔ BLOCK — ${result.blocks.length} reason(s); deploy MUST NOT proceed:\n`);
    for (const b of result.blocks) process.stderr.write(`      ${b}\n`);
    process.stderr.write(`${line}\n`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  // Resolve inputs. FRN checkout dir is the same one the image build uses — pin via env, hard-require.
  const frnDir = env.FRN_CHECKOUT_DIR || argFlag(argv, '--frn-dir');
  if (!frnDir) {
    process.stderr.write('preflight-drafter-gate: FRN_CHECKOUT_DIR (or --frn-dir) is required — the FRN checkout the image build uses.\n');
    return 2;
  }
  if (!existsSync(frnDir)) {
    process.stderr.write(`preflight-drafter-gate: FRN checkout dir does not exist: ${frnDir}\n`);
    return 2;
  }

  // FRN_CHECKOUT_DIR points at the flatratenexus-project dir (where app/, references/, _gate/ live).
  const artifactPath = argFlag(argv, '--artifact')
    || join(frnDir, '_gate', 'drafter_deploy_gate.json');
  const deployImageTag = argFlag(argv, '--image-tag') || env.DRAFTER_IMAGE_TAG || null;

  let deploySha = argFlag(argv, '--deploy-sha') || env.DEPLOY_SHA || null;
  if (!deploySha) {
    try { deploySha = git(frnDir, ['rev-parse', 'HEAD']); } catch { deploySha = null; }
  }

  const artifact = loadArtifact(artifactPath);
  const observed = gatherObserved({ frnDir, artifactPath, deploySha, deployImageTag });
  if (artifact && artifact.gated_sha) resolveAncestry(frnDir, artifact.gated_sha, deploySha, observed);

  const config = {
    gateMajor: ENFORCER_GATE_MAJOR,
    stalenessMs: STALENESS_BACKSTOP_MS,
    expectedFixtureSchemaVersion: env.EXPECTED_FIXTURE_SCHEMA_VERSION
      ? parseInt(env.EXPECTED_FIXTURE_SCHEMA_VERSION, 10)
      : null,
  };

  const result = evaluateGate(artifact, observed, config);
  printReport(result, { artifactPath, frnDir, deploySha, deployImageTag });
  return result.ok ? 0 : 1;
}

function argFlag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Run when invoked directly (not when imported by the test harness).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('preflight-drafter-gate.js')) {
  process.exit(main());
}
