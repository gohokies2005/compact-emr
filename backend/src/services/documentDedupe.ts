import { createHash } from 'node:crypto';

// Byte-identical duplicate detection for the Documents list (Ryan 2026-06-18, "asked 3×": flag
// duplicates like Woodley Misc_2==Misc_3). Identity = EXACT byte size + a sha256 of the leading
// extracted text. A byte-identical re-upload shares both; the combination makes a false match
// essentially impossible for real VA files. High-confidence DISPLAY heuristic — NOT a full-file content
// hash (a contentHash column is a tracked follow-up). Docs with no real bytes don't participate. Pure +
// unit-tested so the grouping logic is verified without a DB.

export interface DedupeDocInput {
  readonly id: string;
  /** The document's byte size as a string (BigInt → string at the route). */
  readonly sizeBytesStr: string;
  /** false → no real bytes (size 0/unknown); the doc never participates in a duplicate group. */
  readonly sizeBytesPositive: boolean;
  /** Concatenated leading page text (the first pages the list already fetched). */
  readonly leadingText: string;
  readonly uploadedAt: Date;
}

function identityKey(d: DedupeDocInput): string | null {
  if (!d.sizeBytesPositive) return null;
  return `${d.sizeBytesStr}:${createHash('sha256').update(d.leadingText).digest('hex')}`;
}

/**
 * Map each doc id → the id of the EARLIEST-uploaded byte-identical sibling (its "primary"), or null if
 * it is itself the primary / has no duplicate. A group's primary is the oldest upload; the rest are
 * flagged as duplicates of it.
 */
export function computeDuplicateOf(docs: readonly DedupeDocInput[]): Map<string, string | null> {
  const primaryByKey = new Map<string, { id: string; at: Date }>();
  for (const d of docs) {
    const key = identityKey(d);
    if (key === null) continue;
    const existing = primaryByKey.get(key);
    if (existing === undefined || d.uploadedAt < existing.at) primaryByKey.set(key, { id: d.id, at: d.uploadedAt });
  }
  const out = new Map<string, string | null>();
  for (const d of docs) {
    const key = identityKey(d);
    const primary = key !== null ? primaryByKey.get(key) : undefined;
    out.set(d.id, primary !== undefined && primary.id !== d.id ? primary.id : null);
  }
  return out;
}
