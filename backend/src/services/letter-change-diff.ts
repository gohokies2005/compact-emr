import { type S3Client } from '@aws-sdk/client-s3';
import type { AppDb } from './db-types.js';
import { resolveCurrentTxtKey, readTxtFromS3 } from './letter-current.js';

/**
 * "WHAT CHANGED SINCE THE PHYSICIAN LAST SIGNED" diff (Ryan 2026-07-03). When an RN surgically edits an
 * already-signed/delivered letter and routes it back for a fresh signature, the physician should be able to
 * GLANCE at what changed and approve — not re-read the whole letter. This computes a DETERMINISTIC
 * sentence-level diff between the last-signed version's TXT and the current version's TXT.
 *
 * DESIGN: zero-dependency, hand-rolled sentence-level LCS. No npm diff lib (avoids any API-Lambda bundling
 * risk on a load-bearing surface) and sentence granularity is exactly the "here is the new/changed text"
 * view the physician needs. Both letter versions are stored as FULL TXT in S3 (LetterRevision.artifactTxt
 * S3Key), so this is a clean two-string compare — no patch reconstruction.
 *
 * This diff is an AID, never a gate: the independent delivery byte-hash gate (delivery-eligibility.ts) is
 * what actually forces a fresh signature before re-delivery. So the wiring below FAILS OPEN — any error, or
 * no prior signature, returns { available: false } and the sign-off UI simply omits the panel.
 */

export type DiffSegmentKind = 'unchanged' | 'added' | 'removed';

export interface DiffSegment {
  readonly kind: DiffSegmentKind;
  readonly text: string;
}

export interface LetterDiff {
  readonly segments: readonly DiffSegment[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changed: boolean;
}

/** Comparison key: collapse all whitespace + trim so a pure re-wrap / whitespace tweak is NOT flagged as a
 *  change (reduces noise), while a real word/case change IS (we do NOT lowercase — a case edit is real). */
function normKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Split letter text into ordered DISPLAY UNITS (roughly sentences), preserving the original text for
 * display. Blank lines are dropped as diff units. Sentences are broken at a terminator (. ! ?) followed by
 * whitespace. Medical abbreviations ("Dr.", "38 C.F.R.") may over-split, but that is harmless: the split is
 * applied identically to BOTH texts, so the LCS still aligns the unchanged units and isolates the changed
 * ones. Granularity only needs to be CONSISTENT, not linguistically perfect.
 */
export function splitUnits(text: string): string[] {
  const units: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const t = part.trim();
      if (t.length > 0) units.push(t);
    }
  }
  return units;
}

/**
 * Standard LCS diff over two unit arrays (compared by normKey). Backtracks into an ordered segment list:
 * `unchanged` (in the common subsequence), `removed` (in old only), `added` (in new only). Deterministic:
 * ties resolved consistently (removed-before-added). A nexus letter is ~50-120 units, so the O(n*m) DP is
 * trivially cheap; a hard cap guards against a pathological input.
 */
export function diffUnits(oldUnits: readonly string[], newUnits: readonly string[]): DiffSegment[] {
  const a = oldUnits;
  const b = newUnits;
  const n = a.length;
  const m = b.length;
  // Pathological-size guard: if either side is absurdly large, don't build a giant DP table — report the
  // whole thing as removed+added (still correct, just coarse). Real letters never hit this.
  if (n > 2000 || m > 2000) {
    return [
      ...a.map((text): DiffSegment => ({ kind: 'removed', text })),
      ...b.map((text): DiffSegment => ({ kind: 'added', text })),
    ];
  }
  const keyA = a.map(normKey);
  const keyB = b.map(normKey);
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = keyA[i] === keyB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const segs: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keyA[i] === keyB[j]) {
      segs.push({ kind: 'unchanged', text: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      segs.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      segs.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    segs.push({ kind: 'removed', text: a[i]! });
    i++;
  }
  while (j < m) {
    segs.push({ kind: 'added', text: b[j]! });
    j++;
  }
  return segs;
}

/** Pure entry point: diff two letter TXT bodies. Deterministic; no I/O. */
export function diffLetters(oldText: string, newText: string): LetterDiff {
  const segments = diffUnits(splitUnits(oldText), splitUnits(newText));
  let addedCount = 0;
  let removedCount = 0;
  for (const s of segments) {
    if (s.kind === 'added') addedCount++;
    else if (s.kind === 'removed') removedCount++;
  }
  return { segments, addedCount, removedCount, changed: addedCount > 0 || removedCount > 0 };
}

export interface ChangesSinceSigned {
  readonly available: boolean;
  readonly changed?: boolean;
  readonly signedVersion?: number;
  readonly currentVersion?: number;
  readonly signedAt?: string;
  readonly addedCount?: number;
  readonly removedCount?: number;
  readonly segments?: readonly DiffSegment[];
  readonly reason?: string;
}

/**
 * Resolve the diff between the version the physician LAST SIGNED (latest SignOff.signedVersion) and the
 * CURRENT version, reading both TXT bodies from S3. FAIL-OPEN: no prior signature, an unresolved version, or
 * ANY read error returns { available: false } — the panel is an aid, never a blocker.
 */
export async function resolveChangesSinceSigned(
  db: AppDb,
  s3: S3Client,
  bucketName: string,
  caseId: string,
  currentVersion: number,
): Promise<ChangesSinceSigned> {
  try {
    const signOff = (await db.signOff.findFirst({
      where: { caseId, signedVersion: { not: null } },
      orderBy: { signedAt: 'desc' },
      select: { signedVersion: true, signedAt: true },
    })) as { signedVersion: number | null; signedAt: Date | null } | null;

    if (signOff === null || signOff.signedVersion === null) {
      return { available: false, reason: 'no_prior_signature' };
    }
    const signedVersion = signOff.signedVersion;
    const signedAt = signOff.signedAt instanceof Date ? signOff.signedAt.toISOString() : undefined;

    // Signed version IS the current version → nothing changed since signing.
    if (signedVersion === currentVersion) {
      return {
        available: true,
        changed: false,
        signedVersion,
        currentVersion,
        addedCount: 0,
        removedCount: 0,
        segments: [],
        ...(signedAt !== undefined ? { signedAt } : {}),
      };
    }

    const signedRef = await resolveCurrentTxtKey(db, caseId, signedVersion);
    const currentRef = await resolveCurrentTxtKey(db, caseId, currentVersion);
    if (signedRef === null || currentRef === null) {
      return { available: false, reason: 'version_unresolved' };
    }
    const [oldTxt, newTxt] = await Promise.all([
      readTxtFromS3(s3, bucketName, signedRef.txtKey, { caseId, version: signedVersion }),
      readTxtFromS3(s3, bucketName, currentRef.txtKey, { caseId, version: currentVersion }),
    ]);
    const d = diffLetters(oldTxt, newTxt);
    return {
      available: true,
      changed: d.changed,
      signedVersion,
      currentVersion,
      addedCount: d.addedCount,
      removedCount: d.removedCount,
      segments: d.segments,
      ...(signedAt !== undefined ? { signedAt } : {}),
    };
  } catch {
    return { available: false, reason: 'error' };
  }
}
